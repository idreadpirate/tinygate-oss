import { pathToFileURL } from 'node:url';
// usage: node grade.mjs <gen.mjs> <solution.mjs> [seed] [K]
const [, , genPath, solPath, seedArg, kArg] = process.argv;
const gen = await import(pathToFileURL(genPath).href);
let sol; try { sol = await import(pathToFileURL(solPath).href); } catch (e) { console.log('FAIL: solution import threw — ' + e.message); process.exit(1); }
const fn = sol[gen.fn];
if (typeof fn !== 'function') { console.log(`FAIL: solution does not export ${gen.fn}()`); process.exit(1); }
const eq = gen.eq || ((a, b) => JSON.stringify(a) === JSON.stringify(b));
let seed = ((seedArg ? Number(seedArg) : Date.now()) >>> 0) || 1;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const K = kArg ? Number(kArg) : 300;
for (let i = 0; i < K; i++) {
  const [input, expected] = gen.gen(rand);       // truth-by-construction: expected comes FROM the generator
  let got, threw = false;
  try { got = fn(structuredClone(input)); } catch { threw = true; }
  if (threw || !eq(got, expected)) {
    console.log(`FAIL @case ${i + 1}/${K}: input=${JSON.stringify(input).slice(0, 100)} got=${threw ? 'THREW' : JSON.stringify(got)?.slice(0, 80)} want=${JSON.stringify(expected).slice(0, 80)}`);
    process.exit(1);
  }
}
console.log(`PASS ${K}/${K}`); process.exit(0);
