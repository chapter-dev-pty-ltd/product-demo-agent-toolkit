import { findFfmpeg, run } from '../tools.ts'

export async function convertExport(
  input: string,
  output: string,
  format: 'webm' | 'gif',
): Promise<void> {
  const args =
    format === 'webm'
      ? [
          '-c:v',
          'libvpx-vp9',
          '-crf',
          '32',
          '-b:v',
          '0',
          '-deadline',
          'realtime',
          '-cpu-used',
          '4',
          '-c:a',
          'libopus',
        ]
      : [
          '-filter_complex',
          '[0:v]fps=15,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse',
          '-an',
          '-loop',
          '0',
        ]
  await run(await findFfmpeg(), ['-loglevel', 'error', '-y', '-i', input, ...args, output])
}
