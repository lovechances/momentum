import { afterEach, describe, expect, it, vi } from 'vitest'
import { compressImage } from './media'

const fakeFile = (overrides: Partial<Pick<File, 'name' | 'size' | 'type'>> = {}) => ({
  name: 'photo.jpg',
  size: 12,
  type: 'image/jpeg',
  ...overrides,
}) as File

function installCanvas(blob = new Blob(['jpeg'], { type: 'image/jpeg' })) {
  const context = {
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: '',
  }
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    toBlob: vi.fn((callback: BlobCallback, type?: string, quality?: number) => callback(blob)),
  }
  vi.stubGlobal('document', { createElement: vi.fn(() => canvas) })
  return { canvas, context }
}

function installBitmap(width: number, height: number) {
  const bitmap = { width, height, close: vi.fn() }
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap))
  return bitmap
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('compressImage', () => {
  it('rejects untrusted raster formats before decoding', async () => {
    const decode = vi.fn()
    vi.stubGlobal('createImageBitmap', decode)

    await expect(compressImage(fakeFile({ name: 'vector.svg', type: 'image/svg+xml' })))
      .rejects.toThrow('JPEG, PNG, WebP, AVIF, HEIC, or HEIF')
    expect(decode).not.toHaveBeenCalled()
  })

  it('accepts a known extension when iOS omits the MIME type', async () => {
    const bitmap = installBitmap(800, 600)
    const { canvas } = installCanvas()

    const result = await compressImage(fakeFile({ name: 'camera.HEIC', type: '' }))

    expect(result).toMatchObject({ mimeType: 'image/jpeg', width: 800, height: 600, bytes: 4 })
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.84)
    expect(bitmap.close).toHaveBeenCalledOnce()
  })

  it('rejects empty and oversized inputs without decoding them', async () => {
    const decode = vi.fn()
    vi.stubGlobal('createImageBitmap', decode)

    await expect(compressImage(fakeFile({ size: 0 }))).rejects.toThrow('empty')
    await expect(compressImage(fakeFile({ size: 25 * 1024 * 1024 + 1 }))).rejects.toThrow('under 25 MB')
    expect(decode).not.toHaveBeenCalled()
  })

  it('scales the longest edge to 1600 pixels and releases the decoded bitmap', async () => {
    const bitmap = installBitmap(4_000, 3_000)
    const { canvas, context } = installCanvas()

    const result = await compressImage(fakeFile())

    expect(result).toMatchObject({ mimeType: 'image/jpeg', width: 1_600, height: 1_200, bytes: 4 })
    expect(canvas).toMatchObject({ width: 1_600, height: 1_200 })
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 1_600, 1_200)
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 1_600, 1_200)
    expect(bitmap.close).toHaveBeenCalledOnce()
  })

  it('falls back to the native image element decoder and revokes its object URL', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('unsupported') }))
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:photo', revokeObjectURL })

    const image = {
      decoding: '',
      naturalWidth: 2_000,
      naturalHeight: 1_000,
      onload: null as null | (() => void),
      onerror: null as null | (() => void),
      removeAttribute: vi.fn(),
    }
    Object.defineProperty(image, 'src', {
      set: () => queueMicrotask(() => image.onload?.()),
    })
    const context = { drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '' }
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
      toBlob: (callback: BlobCallback) => callback(new Blob(['jpeg'], { type: 'image/jpeg' })),
    }
    vi.stubGlobal('document', { createElement: (tag: string) => tag === 'img' ? image : canvas })

    const result = await compressImage(fakeFile({ name: 'photo.heic', type: 'image/heic' }))

    expect(result).toMatchObject({ width: 1_600, height: 800 })
    expect(image.removeAttribute).toHaveBeenCalledWith('src')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:photo')
  })

  it('rejects impractical source dimensions and still releases decoder memory', async () => {
    const bitmap = installBitmap(10_000, 7_000)

    await expect(compressImage(fakeFile())).rejects.toThrow('under 60 megapixels')
    expect(bitmap.close).toHaveBeenCalledOnce()
  })

  it('fails gracefully when the browser cannot provide a canvas context', async () => {
    const bitmap = installBitmap(1_000, 800)
    vi.stubGlobal('document', {
      createElement: vi.fn(() => ({ width: 0, height: 0, getContext: () => null })),
    })

    await expect(compressImage(fakeFile())).rejects.toThrow('not available in this browser')
    expect(bitmap.close).toHaveBeenCalledOnce()
  })
})
