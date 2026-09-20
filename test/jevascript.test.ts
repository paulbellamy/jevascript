// Ports of probably's runtime tests (those that still apply to a library), plus library-only behaviour.
import {test,expect} from 'bun:test';
import {distribution,Jevascript,type Provider} from '../src/jevascript';
const absent:Provider={write:async()=>{throw new Error('Unexpected generation');},judge:async()=>{throw new Error('Unexpected judgment');}};
const judge=(yes:number):Provider=>({...absent,judge:async(_,labels)=>({probabilities:Object.fromEntries(labels.map((l,i)=>[l,i===0?yes:(1-yes)/(labels.length-1)]))})});
const fixed=(draw:number)=>(p:Provider):Provider=>({...p,judge:async(...a)=>({...await p.judge(...a),draw})});
const condition=(p:Jevascript,input:string,out:string[])=>p.feels(input,'urgent',{confidence:.8}).when({yes:()=>out.push('yes'),maybe:()=>out.push('maybe'),no:()=>out.push('no')});

test('confidence is symmetric: high yes, ambiguous, high no',async()=>{
  for(const [prob,text] of [[.91,'yes'],[.6,'maybe'],[.09,'no']] as const){const out:string[]=[];await condition(new Jevascript(judge(prob)),'x',out);expect(out).toEqual([text]);}
});
test('feels exposes verdict, p(yes) and booleans',async()=>{
  const p=new Jevascript(judge(.6));
  const f=await p.feels('x','urgent');
  expect(f.verdict).toBe('yes');expect(f.yes).toBe(true);expect(f.probability).toBeCloseTo(.6);
  expect((await p.feels('x','urgent',{confidence:.9})).maybe).toBe(true);
});
test('missing maybe handler runs nothing',async()=>{
  const out:string[]=[];
  await new Jevascript(judge(.6)).feels('x','q',{confidence:.9}).when({yes:()=>out.push('y'),no:()=>out.push('n')});
  expect(out).toEqual([]);
});
test('generation receives only explicitly supplied context',async()=>{
  const p:Provider={...absent,write:async(prompt,value)=>{expect(prompt).toBe('rewrite');expect(value).toBe('hello');return 'hi';}};
  expect(await new Jevascript(p).llm('rewrite','hello')).toBe('hi');
});
test('a plain while loop over feels reevaluates the updated value and exits',async()=>{
  const seen:unknown[]=[];
  const p:Provider={write:async()=>'normal',judge:async(value,labels)=>{seen.push(value);return {probabilities:{[labels[0]]:value==='corporate'?.99:.01,[labels[1]]:value==='corporate'?.01:.99}};}};
  const j=new Jevascript(p);let draft='corporate';
  while((await j.feels(draft,'corporate')).yes)draft=await j.llm('fix',draft);
  expect(seen).toEqual(['corporate','normal']);expect(draft).toBe('normal');
});
test('chaos samples probabilities from the draw',async()=>{
  const out:string[]=[];
  const run=async(draw:number)=>{out.length=0;const j=new Jevascript(fixed(draw)(judge(.9)));await j.chaos(()=>j.feels('x','urgent').when({yes:()=>out.push('yes'),no:()=>out.push('no')}));return [...out];};
  expect(await run(.95)).toEqual(['no']);expect(await run(.5)).toEqual(['yes']);
});
test('chaos scope follows async control flow, and ends with the block',async()=>{
  const j=new Jevascript(judge(.9));
  await j.chaos(async()=>{await Promise.resolve();expect((await j.feels('x','q')).sampled).toBe(true);});
  expect((await j.feels('x','q')).sampled).toBe(false);
});
test('confidence gates happen before chaos sampling',async()=>{
  const out:string[]=[];const j=new Jevascript(fixed(.1)(judge(.6)));
  await j.chaos(()=>condition(j,'x',out));expect(out).toEqual(['maybe']);
});
test('match chooses highest probability, deterministic first-label ties, and returns a value',async()=>{
  const program=(j:Jevascript)=>j.match('x',{bug:()=>'bug' as const,idea:()=>Promise.resolve('idea' as const)});
  expect(await program(new Jevascript(judge(.2)))).toBe('idea');
  expect(await program(new Jevascript(judge(.5)))).toBe('bug');
});
test('match label count is bounded like the DSL',async()=>{
  await expect(new Jevascript(judge(.5)).match('x',{one:()=>1})).rejects.toThrow('2 to 8');
});
test('probabilities are validated',()=>{
  for(const p of [{a:2,b:-1},{a:NaN,b:1},{a:0,b:0},{a:.5},{a:'0.5',b:.5}])expect(()=>distribution(p,['a','b'])).toThrow();
  expect(distribution({a:.5,b:.51},['a','b']).a).toBeCloseTo(.495);
});
