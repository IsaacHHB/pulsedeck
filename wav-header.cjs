/** Reads and validates RIFF/WAVE headers in the main process. Never trusts the renderer's description of bytes. */
function parseWav(data, { fileSize } = {}) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const sizeOnDisk = fileSize ?? buffer.length;
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('The audio is not a WAV file.');
  const riffEnd = buffer.readUInt32LE(4) + 8;
  if (riffEnd > sizeOnDisk || riffEnd < 44) throw new Error('The WAV file is truncated or has an invalid RIFF size.');
  let offset = 12, fmt = null, dataOffset = -1, dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4), size = buffer.readUInt32LE(offset + 4), body = offset + 8;
    if (body + size > riffEnd) throw new Error('The WAV file is truncated.');
    if (id === 'fmt ' && size >= 16 && body + 16 <= buffer.length) {
      fmt = { format: buffer.readUInt16LE(body), channels: buffer.readUInt16LE(body + 2), sampleRate: buffer.readUInt32LE(body + 4), byteRate: buffer.readUInt32LE(body + 8), blockAlign: buffer.readUInt16LE(body + 12), bitsPerSample: buffer.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      dataOffset = body; dataBytes = size;
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || dataOffset < 0) throw new Error('The WAV file is missing its format or audio data.');
  if (!fmt.channels || !fmt.sampleRate || !fmt.blockAlign) throw new Error('The WAV file has an invalid format.');
  if (dataBytes % fmt.blockAlign) throw new Error('The WAV file contains an incomplete audio frame.');
  const frames = Math.floor(dataBytes / fmt.blockAlign);
  return { ...fmt, dataOffset, dataBytes, frames, duration: frames / fmt.sampleRate };
}

/** Canonical generated audio: 16-bit PCM, mono or stereo, one fixed sample rate, bounded length. */
function assertCanonicalWav(data, { sampleRate = 48000, maxSeconds = 180, maxBytes = 64 * 1024 * 1024, fileSize } = {}) {
  if (!data || !data.length) throw new Error('The audio is empty.');
  if ((fileSize ?? data.length) > maxBytes) throw new Error(`The audio is larger than ${Math.round(maxBytes / 1048576)} MB.`);
  const info = parseWav(data, { fileSize });
  if (info.format !== 1 || info.bitsPerSample !== 16) throw new Error('Generated audio must be 16-bit PCM WAV.');
  if (info.channels < 1 || info.channels > 2) throw new Error('Only mono and stereo audio are supported.');
  if (info.blockAlign !== info.channels * 2 || info.byteRate !== info.sampleRate * info.blockAlign) throw new Error('The WAV file has invalid PCM alignment or byte rate.');
  if (sampleRate && info.sampleRate !== sampleRate) throw new Error(`Generated audio must use ${sampleRate} Hz.`);
  if (info.frames < 1) throw new Error('The audio contains no samples.');
  if (info.duration > maxSeconds + 1e-6) throw new Error(`The audio is longer than ${maxSeconds} seconds.`);
  if (info.dataOffset + info.frames * info.blockAlign > (fileSize ?? data.length)) throw new Error('The WAV file is truncated.');
  return info;
}

module.exports = { parseWav, assertCanonicalWav };
