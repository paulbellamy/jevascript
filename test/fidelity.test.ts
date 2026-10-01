// Replay probably's own shipped recordings (real Jev + Llama results, recorded once by the reference
// interpreter) through the TS ports. Output must match byte-for-byte, every recorded effect must be
// consumed, and re-recording the replay must reproduce the recording exactly (so the ports issue the same
// effects with the same args). Zero model calls.
import {expect,test} from 'bun:test';
import {existsSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Jevascript} from '../src/jevascript';
import {type Recording,record,replay} from '../src/recording';
import {jev,scratch,tape} from './cli';
import recordings from './fixtures/recordings.json';

type ProbablyRun={version:1; source:string; input:string; tape:Recording; output:string[]};
const dir=join(import.meta.dir,'../examples');
const bySource=new Map(readdirSync(dir).filter(f=>f.endsWith('.prob')).map(f=>[readFileSync(join(dir,f),'utf8').trim(),f.replace('.prob','')]));

for(const rec of recordings as ProbablyRun[]) {
  const name=bySource.get(rec.source.trim());
  test(`replays probably's ${name} recording (${rec.tape.length} effects)`,async()=>{
    expect(name).toBeDefined();
    const program=(await import(join(dir,`${name}.ts`))).default;
    const replaying=replay(rec.tape),recording=record(replaying);
    const output:string[]=[];
    await program(new Jevascript(recording),rec.input,(s:string)=>output.push(s));
    replaying.finish();
    expect(output).toEqual(rec.output);
    expect(recording.recording).toEqual(rec.tape);
  });
}
// The shell ports (the ones without llm) replay the same recordings through `jev replay`, as separate processes.
for(const rec of recordings as ProbablyRun[]) {
  const name=bySource.get(rec.source.trim()),script=join(dir,`${name}.sh`);
  if(!existsSync(script))continue;
  test(`jev replays probably's ${name} recording through ${name}.sh`,async()=>{
    const scratchDir=scratch(),file=join(scratchDir,'tape.jsonl'),again=join(scratchDir,'again.jsonl');
    writeFileSync(file,rec.tape.map(e=>`${JSON.stringify(e)}\n`).join(''));
    const run=await jev(['replay',file,'--','bash',script],{stdin:rec.input,env:{JEV_RECORD:again}});
    expect(run).toMatchObject({err:'',code:0});
    expect(run.out.split('\n').slice(0,-1)).toEqual(rec.output);
    expect(tape(again)).toEqual(rec.tape);
  });
}
test('all seven examples have a recording',()=>{expect((recordings as ProbablyRun[]).length).toBe(7);expect(bySource.size).toBe(7);});
