'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../shared/core');

function loadParser() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const instrumented = source.replace(/\}\)\(\);\s*$/, `
    globalThis.__parserTest = { findAssignments, guessDate, guessWeekday, isoDate, dedupeSameDateNoise };
  })();`);
  const context = {
    window: { TheoCore: core, crypto: globalThis.crypto },
    document: { readyState: 'loading', addEventListener() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    crypto: globalThis.crypto, console, setTimeout, clearTimeout, setInterval, clearInterval,
    location: { hash: '' }, navigator: {}
  };
  vm.runInNewContext(instrumented, context);
  return context.__parserTest;
}

const parser = loadParser();

test('i PDF misti combinano pagina a colonne e pagina riga per riga', () => {
  const pages = [
    {
      pageNum: 1, lines: [], lineBoxes: [],
      rawItems: [
        { str: 'Video', x: 20, y: 700 }, { str: 'Mixer', x: 120, y: 700 }, { str: 'Microfono', x: 220, y: 700 },
        { str: '4/11', x: 20, y: 600 }, { str: 'Piano', x: 125, y: 600 }
      ]
    },
    {
      pageNum: 2, rawItems: [{ str: 'Piano', x: 20, y: 500 }],
      lines: ['Presidente Piano', '5/11/2027'], lineBoxes: [
        { minX: 10, maxX: 120, y: 500 }, { minX: 10, maxX: 80, y: 480 }
      ]
    }
  ];
  const matches = parser.findAssignments(pages, 'programma-2027.pdf');
  assert.equal(matches.length, 2);
  assert.equal(matches[0].guessedRole, 'Mixer');
  assert.equal(matches[1].guessedDate, '2027-11-05');
});

test('la data senza anno usa quella presente nel nome del file', () => {
  const pages = [{
    pageNum: 1, rawItems: [{ str: 'Piano', x: 10, y: 500 }],
    lines: ['Piano 4/11'], lineBoxes: [{ minX: 10, maxX: 80, y: 500 }]
  }];
  assert.equal(parser.findAssignments(pages, 'programma-2028.pdf')[0].guessedDate, '2028-11-04');
});

test('il giorno della settimana può essere oggi', () => {
  const stems = ['domenic', 'luned', 'marted', 'mercoled', 'gioved', 'venerd', 'sabat'];
  const today = new Date();
  assert.equal(parser.guessWeekday(stems[today.getDay()]), parser.isoDate(today));
});

test('la deduplica rimuove cantico e 3 min solo se esiste un incarico pulito', () => {
  const matches = [
    { guessedDate: '2026-11-20', rawLine: 'Presidente Piano' },
    { guessedDate: '2026-11-20', rawLine: 'Piano cantico' },
    { guessedDate: '2026-11-20', rawLine: 'Piano 3 min' }
  ];
  assert.equal(parser.dedupeSameDateNoise(matches).length, 1);
});
