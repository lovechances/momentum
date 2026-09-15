import type { MediaRecord } from './domain'

const MAX_INPUT_BYTES = 25 * 1024 * 1024
const MAX_SOURCE_EDGE = 12_000
const MAX_SOURCE_PIXELS = 60_000_000
const MAX_OUTPUT_EDGE = 1_600
const MAX_OUTPUT_BYTES = 6 * 1024 * 1024
const JPEG_QUALITY = 0.84

const SUPPORTED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/pjpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/heif',
])

const MIME_BY_EXTENSION: Record<string, string> = {
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  jfif: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

interface DecodedImage {
  source: CanvasImageSource
  width: number
  height: number
  cleanup: () => void
}

function detectedMimeType(file: File): string {
  const declared = file.type.toLowerCase().split(';', 1)[0].trim()
  if (declared && declared !== 'application/octet-stream') return declared

  const extension = file.name.split('.').pop()?.toLowerCase()
  return extension ? MIME_BY_EXTENSION[extension] ?? '' : ''
}

function validateFile(file: File) {
  if (!SUPPORTED_MIME_TYPES.has(detectedMimeType(file))) {
    throw new Error('Please choose a JPEG, PNG, WebP, AVIF, HEIC, or HEIF image.')
  }
  if (file.size === 0) throw new Error('That image file is empty.')
  if (file.size > MAX_INPUT_BYTES) throw new Error('That image is too large. Choose one under 25 MB.')
}

function validateDimensions(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error('That image has invalid dimensions.')
  }
  if (width > MAX_SOURCE_EDGE || height > MAX_SOURCE_EDGE || width * height > MAX_SOURCE_PIXELS) {
    throw new Error('That image has too many pixels. Choose one under 60 megapixels.')
  }
}

function imageReadError() {
  return new Error('This image could not be read. On iPhone, try a screenshot or the Most Compatible camera format.')
}

async function decodeWithImageElement(file: File): Promise<DecodedImage> {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') throw imageReadError()

  const image = document.createElement('img')
  const objectUrl = URL.createObjectURL(file)

  return new Promise((resolve, reject) => {
    const releaseUrl = () => URL.revokeObjectURL(objectUrl)
    image.decoding = 'async'
    image.onload = () => {
      const width = image.naturalWidth
      const height = image.naturalHeight
      resolve({
        source: image,
        width,
        height,
        cleanup: () => {
          image.onload = null
          image.onerror = null
          image.removeAttribute('src')
          releaseUrl()
        },
      })
    }
    image.onerror = () => {
      image.onload = null
      image.onerror = null
      releaseUrl()
      reject(imageReadError())
    }
    try {
      image.src = objectUrl
    } catch {
      image.onload = null
      image.onerror = null
      releaseUrl()
      reject(imageReadError())
    }
  })
}

async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof globalThis.createImageBitmap === 'function') {
    try {
      const bitmap = await globalThis.createImageBitmap(file)
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        cleanup: () => bitmap.close(),
      }
    } catch {
      // Safari support varies by source format, so its native image decoder is a useful fallback.
    }
  }

  return decodeWithImageElement(file)
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error('Image compression failed. Please try a different image.')),
        'image/jpeg',
        JPEG_QUALITY,
      )
    } catch {
      reject(new Error('Image compression failed. Please try a different image.'))
    }
  })
}

export async function compressImage(file: File): Promise<MediaRecord> {
  validateFile(file)
  const decoded = await decodeImage(file)

  try {
    validateDimensions(decoded.width, decoded.height)

    const scale = Math.min(1, MAX_OUTPUT_EDGE / Math.max(decoded.width, decoded.height))
    const width = Math.max(1, Math.round(decoded.width * scale))
    const height = Math.max(1, Math.round(decoded.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height

    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('Image compression is not available in this browser.')

    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.drawImage(decoded.source, 0, 0, width, height)

    const blob = await canvasToJpeg(canvas)
    if (blob.size === 0) throw new Error('Image compression produced an empty file. Please try again.')
    if (blob.size > MAX_OUTPUT_BYTES) throw new Error('The compressed image is still too large. Choose a smaller image.')

    return {
      id: crypto.randomUUID(),
      blob,
      mimeType: 'image/jpeg',
      width,
      height,
      bytes: blob.size,
      createdAt: new Date().toISOString(),
    }
  } catch (error) {
    if (error instanceof Error) throw error
    throw new Error('That image could not be processed. Please try a different image.')
  } finally {
    decoded.cleanup()
  }
}
