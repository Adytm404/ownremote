// Logo ASCII untuk CLI: panah cursor + tulisan "OWN REMOTE".
// Badan huruf memakai satu karakter padat ('#') supaya bentuknya jelas, bayangan '=' memberi kesan timbul,
// dan nuansa "kode simbol" ada di panah serta garis aksen.

const FONT = {
  R: ['######.', '##...##', '##...##', '######.', '##..##.', '##...##'],
  E: ['#######', '##.....', '#####..', '##.....', '##.....', '#######'],
  M: ['##...##', '###.###', '#######', '##.#.##', '##...##', '##...##'],
  O: ['.#####.', '##...##', '##...##', '##...##', '##...##', '.#####.'],
  T: ['######', '..##..', '..##..', '..##..', '..##..', '..##..'],
  C: ['.######', '##.....', '##.....', '##.....', '##.....', '.######'],
  U: ['##...##', '##...##', '##...##', '##...##', '##...##', '.#####.'],
  S: ['.######', '##.....', '.#####.', '.....##', '.....##', '######.'],
  W: ['##...##', '##...##', '##.#.##', '#######', '###.###', '##...##'],
  N: ['##...##', '###..##', '####.##', '##.####', '##..###', '##...##'],
};

// o = garis tepi, f = isian
const ARROW = [
  'o',
  'oo',
  'ofo',
  'offo',
  'offfo',
  'offffo',
  'offfffo',
  'offffffo',
  'offfoooo',
  'ofooffo',
  'oo  offo',
  'o    offo',
  '      oo',
];

const LETTER_GAP = 2;
const FILL = '#';
const SHADOW = '=';
const ACCENT = '#=@!$*)(';

// Susun satu kata menjadi grid 2D: 'X' = badan huruf, 'S' = bayangan, ' ' = kosong
function wordGrid(word) {
  const height = 6;
  const rows = Array.from({ length: height + 1 }, () => []);
  let x = 0;
  for (const ch of word) {
    const glyph = FONT[ch];
    glyph.forEach((line, y) => {
      [...line].forEach((cell, i) => {
        if (cell === '#') rows[y][x + i] = 'X';
      });
    });
    x += glyph[0].length + LETTER_GAP;
  }
  const width = x - LETTER_GAP + 1;
  // bayangan: geser 1 ke kanan-bawah, hanya di sel yang kosong
  for (let y = height - 1; y >= 0; y--) {
    for (let i = width - 1; i >= 0; i--) {
      if (rows[y][i] === 'X' && rows[y + 1][i + 1] !== 'X') rows[y + 1][i + 1] = 'S';
    }
  }
  return rows.map((r) => Array.from({ length: width }, (_, i) => r[i] || ' '));
}

function palette() {
  const rich = process.stdout.hasColors?.(256);
  const fg = (n) => `\x1b[38;5;${n}m`;
  return {
    rich,
    bold: '\x1b[1m',
    reset: '\x1b[0m',
    dim: '\x1b[90m',
    shadow: rich ? fg(238) : '\x1b[90m',
    arrowEdge: rich ? fg(255) : '\x1b[97m',
    arrowFill: rich ? fg(191) : '\x1b[93m',
    // gradasi per baris: cyan -> hijau limau
    textRows: rich ? [51, 51, 50, 49, 48, 84, 120, 156, 155, 154, 190, 190, 226, 226] : null,
    word: ['\x1b[96m', '\x1b[92m'],
    fg,
  };
}

function paintGrid(grid, colorOf, p) {
  return grid.map((row, y) => {
    let out = '';
    let current = '';
    for (const cell of row) {
      let color = '';
      let ch = ' ';
      if (cell === 'X') { color = p.bold + colorOf(y); ch = FILL; }
      else if (cell === 'S') { color = p.reset + p.shadow; ch = SHADOW; }
      if (ch !== ' ' && color !== current) { out += p.reset + color; current = color; }
      out += ch;
    }
    return out + p.reset;
  });
}

/** Logo besar untuk menu utama. */
function bigLogo(indent = '  ') {
  const p = palette();
  const top = wordGrid('OWN');
  const bottom = wordGrid('REMOTE');
  const color = (offset, wordIdx) => (y) => (p.rich ? p.fg(p.textRows[offset + y]) : p.word[wordIdx]);
  const text = [
    ...paintGrid(top, color(0, 0), p), // 7 baris (6 + bayangan)
    ...paintGrid(bottom, color(7, 1), p), // 7 baris
  ];

  const arrow = ARROW.map((line) =>
    [...line.padEnd(9)].map((c) => (c === 'o' ? `${p.arrowEdge}@` : c === 'f' ? `${p.arrowFill}#` : ' ')).join('') + p.reset,
  );
  // panah 13 baris, teks 14 baris: geser panah 1 baris ke bawah agar seimbang
  const lines = [];
  for (let i = 0; i < text.length; i++) {
    const a = i >= 1 && i - 1 < arrow.length ? arrow[i - 1] : ' '.repeat(9);
    lines.push(`${indent}${a}    ${text[i]}`);
  }

  const width = Math.max(top[0].length, bottom[0].length);
  const accent = ACCENT.repeat(Math.ceil(width / ACCENT.length)).slice(0, width);
  const tagline = 'control your PC from your phone';
  const left = Math.floor((width - tagline.length) / 2);
  lines.push(`${indent}${' '.repeat(13)}${p.shadow}${accent}${p.reset}`);
  lines.push(`${indent}${' '.repeat(13 + Math.max(0, left))}${p.dim}${tagline}${p.reset}`);
  return lines.join('\n');
}

/** Header ringkas (1 baris) untuk sub-menu. */
function smallLogo(subtitle, indent = '  ') {
  const p = palette();
  const accent = p.rich ? p.fg(191) : '\x1b[93m';
  const title = p.rich ? `${p.bold}${p.fg(51)}` : '\x1b[1m\x1b[96m';
  const sub = subtitle ? `  ${p.dim}::${p.reset}  \x1b[33m${subtitle}${p.reset}` : '';
  return `${indent}${accent}#=@>${p.reset} ${title}OWNREMOTE${p.reset} ${accent}<@=#${p.reset}${sub}`;
}

module.exports = { bigLogo, smallLogo };
