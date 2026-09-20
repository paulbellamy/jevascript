// Ports of probably's runtime.test.ts, plus tests for things the library can do that the DSL cannot.
import {test,expect} from 'bun:test';
import {run,distribution,Jevascript,type Provider} from '../src/jevascript';
const absent:Provider={write:async()=>{throw new Error('Unexpected generation');},judge:async()=>{throw new Error('Unexpected judgment');}};
const judge=(yes:number):Provider=>({...absent,judge:async(_,labels)=>Object.fromEntries(labels.map((l,i)=>[l,i===0?yes:(1-yes)/(labels.length-1)]))});
const condition=(p:Jevascript,input:string)=>p.feels(input,'urgent',{confidence:.8}).when({yes:()=>p.print('yes'),maybe:()=>p.print('maybe'),no:()=>p.print('no')});

test('confidence is symmetric: high yes, ambiguous, high no',async()=>{
  for(const [p,text] of [[.91,'yes'],[.6,'maybe'],[.09,'no']] as const)expect((await run(condition,{provider:judge(p)})).output).toEqual([text]);
});
test('feels exposes verdict, p(yes) and booleans',async()=>{
  const p=new Jevascript({provider:judge(.6)});
  const f=await p.feels('x','urgent');
  expect(f.verdict).toBe('yes');expect(f.yes).toBe(true);expect(f.probability).toBeCloseTo(.6);
  expect((await p.feels('x','urgent',{confidence:.9})).maybe).toBe(true);
});
test('missing maybe handler runs nothing',async()=>{
  const r=await run((p,i)=>p.feels(i,'q',{confidence:.9}).when({yes:()=>p.print('y'),no:()=>p.print('n')}),{provider:judge(.6)});
  expect(r.output).toEqual([]);
});
test('generation receives only explicitly supplied context',async()=>{
  const p:Provider={...absent,write:async(prompt,value)=>{expect(prompt).toBe('rewrite');expect(value).toBe('hello');return 'hi';}};
  const r=await run(async(j,input)=>{const secret='not passed';j.print(await j.llm('rewrite',input));void secret;},{provider:p,input:'hello'});
  expect(r.output).toEqual(['hi']);expect(r.tape[0].args).toEqual({prompt:'rewrite',value:'hello'});
});
test('a plain while loop over feels reevaluates the updated value and exits',async()=>{
  const seen:unknown[]=[];
  const p:Provider={write:async()=>'normal',judge:async(value,labels)=>{seen.push(value);return {[labels[0]]:value==='corporate'?.99:.01,[labels[1]]:value==='corporate'?.01:.99};}};
  const r=await run(async(j,input)=>{let draft=input;while((await j.feels(draft,'corporate')).yes)draft=await j.llm('fix',draft);j.print(draft);},{provider:p,input:'corporate'});
  expect(seen).toEqual(['corporate','normal']);expect(r.output).toEqual(['normal']);
});
test('runaway semantic loops hit the call budget',async()=>{
  await expect(run(async j=>{while((await j.feels('yes','true')).yes)j.print('again');},{provider:judge(.99)})).rejects.toThrow('12 model-call limit');
});
test('chaos samples probabilities; replay preserves sample and generated text',async()=>{
  const p={...judge(.9),write:async()=>'Generated once'};
  const program=async(j:Jevascript)=>{const text=await j.llm('hello');await j.chaos(()=>j.feels(text,'urgent').when({yes:()=>j.print('yes'),no:()=>j.print('no')}));};
  const first=await run(program,{provider:p,random:()=>.95});expect(first.output).toEqual(['no']);
  const replay=await run(program,{provider:absent,replay:first.tape,random:()=>0});expect(replay.output).toEqual(first.output);expect(replay.trace).toEqual(first.trace);
});
test('chaos scope follows async control flow, and ends with the block',async()=>{
  const j=new Jevascript({provider:judge(.9),random:()=>.95});
  await j.chaos(async()=>{await Promise.resolve();expect((await j.feels('x','q')).sampled).toBe(true);});
  expect((await j.feels('x','q')).sampled).toBe(false);
});
test('confidence gates happen before chaos sampling',async()=>{
  const r=await run((j,i)=>j.chaos(()=>condition(j,i)),{provider:judge(.6),random:()=>.1});expect(r.output).toEqual(['maybe']);
});
test('match chooses highest probability, deterministic first-label ties, and returns a value',async()=>{
  const program=(j:Jevascript,i:string)=>j.match(i,{bug:()=>'bug' as const,idea:()=>Promise.resolve('idea' as const)});
  expect(await program(new Jevascript({provider:judge(.2)}),'')).toBe('idea');
  expect(await program(new Jevascript({provider:judge(.5)}),'')).toBe('bug');
});
test('match label count is bounded like the DSL',async()=>{
  await expect(new Jevascript({provider:judge(.5)}).match('x',{one:()=>1})).rejects.toThrow('2 to 8');
});
test('replay rejects altered inputs, missing and surplus effects',async()=>{
  const saved=await run(condition,{provider:judge(.9),input:'one'});
  await expect(run(condition,{provider:absent,input:'two',replay:saved.tape})).rejects.toThrow('does not match');
  await expect(run(condition,{provider:absent,replay:[]})).rejects.toThrow('does not match');
  await expect(run(j=>j.print('ok'),{provider:absent,replay:saved.tape})).rejects.toThrow('unused');
});
test('replay is order-independent, so concurrent judgments replay (the DSL has no concurrency)',async()=>{
  const p:Provider={...absent,judge:async(value,labels)=>({[labels[0]]:value==='a'?.9:.1,[labels[1]]:value==='a'?.1:.9})};
  const program=async(j:Jevascript)=>{const [a,b]=await Promise.all([j.feels('a','q'),j.feels('b','q')]);j.print(`${a.verdict} ${b.verdict}`);};
  const first=await run(program,{provider:p});expect(first.output).toEqual(['yes no']);
  const replay=await run(program,{provider:absent,replay:[...first.tape].reverse()});expect(replay.output).toEqual(['yes no']);
});
test('budgets reject extra model calls',async()=>{
  await expect(run(async j=>{for(let i=0;i<25;i++)await j.llm('a');},{provider:{...absent,write:async()=>'a'}})).rejects.toThrow('12 model-call limit');
  await expect(run(async j=>{for(let i=0;i<3;i++)await j.llm('a');},{provider:{...absent,write:async()=>'a'},maxCalls:2})).rejects.toThrow('2 model-call limit');
});
test('cancelled runs do not execute effects',async()=>{
  const controller=new AbortController();controller.abort();
  await expect(run(j=>j.llm('x'),{provider:{...absent,write:async()=>'a'},signal:controller.signal})).rejects.toThrow();
});
test('probabilities are validated',()=>{
  for(const p of [{a:2,b:-1},{a:NaN,b:1},{a:0,b:0},{a:.5},{a:'0.5',b:.5}])expect(()=>distribution(p,['a','b'])).toThrow();
  expect(distribution({a:.5,b:.51},['a','b']).a).toBeCloseTo(.495);
});
