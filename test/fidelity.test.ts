// Replay probably's own shipped recordings (real Jev + Llama results, recorded once by the reference
// interpreter) through the TS ports. Output must match byte-for-byte and every recorded effect must
// be consumed, in order. Zero model calls.
import {test,expect} from 'bun:test';
import {run,type Effect,type Provider} from '../src/jevascript';
import recordings from './fixtures/recordings.json';
import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';

type Recording={version:1; source:string; input:string; tape:Effect[]; output:string[]; trace:{kind:string; text:string}[]};
const absent:Provider={write:async()=>{throw new Error('Unexpected generation');},judge:async()=>{throw new Error('Unexpected judgment');}};
const dir=join(import.meta.dir,'../examples');
const bySource=new Map(readdirSync(dir).filter(f=>f.endsWith('.prob')).map(f=>[readFileSync(join(dir,f),'utf8').trim(),f.replace('.prob','')]));

for(const rec of recordings as Recording[]) {
  const name=bySource.get(rec.source.trim());
  test(`replays probably's ${name} recording (${rec.tape.length} effects)`,async()=>{
    expect(name).toBeDefined();
    const program=(await import(join(dir,`${name}.ts`))).default;
    const r=await run(program,{provider:absent,input:rec.input,replay:rec.tape,name});
    expect(r.output).toEqual(rec.output);
    expect(r.tape).toEqual(rec.tape);
    // Judge trace matches too (probably's trace carries line numbers and loop-iteration events; ours doesn't).
    const decisions=(t:{kind:string;text:string}[])=>t.filter(t=>t.kind==='judge').map(t=>t.text);
    expect(decisions(r.trace)).toEqual(decisions(rec.trace));
  });
}
test('all seven examples have a recording',()=>{expect((recordings as Recording[]).length).toBe(7);expect(bySource.size).toBe(7);});
