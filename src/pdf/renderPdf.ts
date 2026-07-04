/*
 * Rasterize a PDF (ArrayBuffer) to an array of page image data-URLs, entirely in the
 * browser via pdf.js. No server. Each page is rendered to a canvas at `scale` and encoded
 * as WebP (falls back to PNG if the browser can't encode WebP).
 */
import * as pdfjs from 'pdfjs-dist'
// Vite resolves this to a hashed URL for the worker bundle — required, else pdf.js hangs.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export interface RenderProgress {
  page: number
  total: number
}

export async function renderPdf(
  data: ArrayBuffer,
  scale = 2,
  onProgress?: (p: RenderProgress) => void,
): Promise<string[]> {
  const doc = await pdfjs.getDocument({ data }).promise
  const total = doc.numPages
  const out: string[] = []

  for (let i = 1; i <= total; i++) {
    const pdfPage = await doc.getPage(i)
    const viewport = pdfPage.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas context unavailable')

    await pdfPage.render({ canvasContext: ctx, viewport }).promise

    let url = canvas.toDataURL('image/webp', 0.85)
    if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/png')
    out.push(url)

    // release page resources
    pdfPage.cleanup()
    onProgress?.({ page: i, total })
  }

  await doc.destroy()
  return out
}
