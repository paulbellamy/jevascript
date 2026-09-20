import {test,expect} from 'bun:test';
import {Jevascript,type Provider} from '../src/jevascript';
import {record,replay} from '../src/recording';
const absent:Provider={write:async()=>{throw new Error('Unexpected generation');},judge:async()=>{throw new Error('Unexpected judgment');}};
const judge=(yes:number):Provider=>({...absent,judge:async(_,labels)=>({probabilities:Object.fromEntries(labels.map((l,i)=>[l,i===0?yes:(1-yes)/(labels.length-1)]))})});
const condition=async(p:Jevascript,input:string)=>{const out:string[]=[];await p.feels(input,'urgent',{confidence:.8}).when({yes:()=>out.push('yes'),maybe:()=>out.push('maybe'),no:()=>out.push('no')});return out;};

test('a recording replays generated text and the chaos draw, with no model calls',async()=>{
  const live=record({...judge(.9),write:async()=>'Generated once'});
  const program=async(j:Jevascript)=>{const text=await j.llm('hello');return j.chaos(()=>j.feels(text,'urgent').when({yes:()=>'yes',no:()=>'no'}));};
  const first=await program(new Jevascript(live));
  expect(live.recording).toHaveLength(2);expect(live.recording[1]).toHaveProperty('draw');
  const again=replay(live.recording);
  expect(await program(new Jevascript(again))).toBe(first);again.finish();
});
test('recordings use probably\'s effect shape',async()=>{
  const live=record({...judge(.9),write:async()=>'hi'});const j=new Jevascript(live);
  await j.llm('rewrite','hello');await j.llm('bare');await j.feels('x','q');
  expect(live.recording[2]).toMatchObject({kind:'judge',args:{value:'x',labels:['q','NOT: q']}});
  expect((live.recording[2] as any).result['NOT: q']).toBeCloseTo(.1);
  expect(live.recording.slice(0,2)).toEqual([
    {kind:'write',args:{prompt:'rewrite',value:'hello'},result:'hi'},
    {kind:'write',args:{prompt:'bare'},result:'hi'},
  ]);
});
test('replay rejects altered inputs, missing and surplus effects, and missing draws',async()=>{
  const live=record(judge(.9));await condition(new Jevascript(live),'one');
  await expect(condition(new Jevascript(replay(live.recording)),'two')).rejects.toThrow('does not match');
  await expect(condition(new Jevascript(replay([])),'one')).rejects.toThrow('does not match');
  expect(()=>replay(live.recording).finish()).toThrow('unused');
  const j=new Jevascript(replay(live.recording));
  await expect(j.chaos(()=>j.feels('one','urgent',{confidence:.8}))).rejects.toThrow('no chaos draw');
});
test('replay is order-independent, so concurrent judgments replay (the DSL has no concurrency)',async()=>{
  const p:Provider={...absent,judge:async(value,labels)=>({probabilities:{[labels[0]]:value==='a'?.9:.1,[labels[1]]:value==='a'?.1:.9}})};
  const program=async(j:Jevascript)=>{const [a,b]=await Promise.all([j.feels('a','q'),j.feels('b','q')]);return `${a.verdict} ${b.verdict}`;};
  const live=record(p);expect(await program(new Jevascript(live))).toBe('yes no');
  expect(await program(new Jevascript(replay([...live.recording].reverse())))).toBe('yes no');
});
