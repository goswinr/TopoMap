// Packs files into a ZIP archive in the browser, compressed with the built-in
// CompressionStream (raw deflate, which is what ZIP stores).

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @param {{name: string, data: Uint8Array}[]} files names in ASCII
 * @returns {Promise<Blob>} the ZIP archive
 */
export async function zip(files) {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [];
  const directory = [];
  let offset = 0;

  for (const { name, data } of files) {
    const deflated = new Uint8Array(
      await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer(),
    );
    const nameBytes = new TextEncoder().encode(name);
    // Fields shared by the local header and the central directory entry, from "version needed".
    const common = new DataView(new ArrayBuffer(26));
    common.setUint16(0, 20, true); // version needed: 2.0, deflate
    common.setUint16(4, 8, true); // compression: deflate
    common.setUint16(6, time, true);
    common.setUint16(8, date, true);
    common.setUint32(10, crc32(data), true);
    common.setUint32(14, deflated.length, true);
    common.setUint32(18, data.length, true);
    common.setUint16(22, nameBytes.length, true);

    const local = new DataView(new ArrayBuffer(4));
    local.setUint32(0, 0x04034b50, true);
    parts.push(local, common, nameBytes, deflated);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true); // version made by
    new Uint8Array(entry.buffer).set(new Uint8Array(common.buffer), 6);
    entry.setUint32(42, offset, true); // where the local header starts
    directory.push(entry, nameBytes);
    offset += 4 + 26 + nameBytes.length + deflated.length;
  }

  const size = directory.reduce((sum, d) => sum + d.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true); // entries on this disk
  end.setUint16(10, files.length, true); // entries in total
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: 'application/zip' });
}
