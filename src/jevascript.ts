// jevascript: probably-lang's primitives as a plain TypeScript library.
// feels / match / whileFeels / chaos / llm, with the same budgets, effect tape and replay
// as the reference interpreter (probably 0.1). Provider interface is byte-compatible, so
// probably's own recordings replay through this runtime unchanged (see test/fidelity.test.ts).
import {AsyncLocalStorage} from 'node:async_hooks';

export type Value = string|number|boolean;
export interface Provider {
  write(prompt:string, value:Value|undefined, signal:AbortSignal):Promise<string>;
  judge(value:Value, labels:string[], signal:AbortSignal):Promise<Record<string,number>>;
}
export type Effect = {kind:'write'|'judge'; args:unknown; result:unknown; draw?:number};
export type Trace = {kind:'write'|'judge'|'print'|'repeat'; text:string; detail?:unknown};
export type Run = {version:1; program:string; input:string; tape:Effect[]; output:string[]; trace:Trace[]};
export type Verdict = 'yes'|'maybe'|'no';
export type Options = {
  provider:Provider;
  replay?:Effect[];            // recorded effects; matched by (kind,args), first unconsumed wins
  signal?:AbortSignal;
  onEvent?:(event:Trace)=>void;
  random?:()=>number;          // chaos draws; injectable for tests
  maxCalls?:number;            // default 12, like probably
  maxLoop?:number;             // default 5, like probably
  timeoutMs?:number;           // default 90_000, like probably
};

export class JevascriptError extends Error {}

/** Validate a judge distribution over the given labels; normalise to sum 1. Identical to probably's. */
export function distribution(raw:unknown, labels:string[]):Record<string,number> {
  if(!raw||typeof raw!=='object')throw new JevascriptError('Judge returned no probabilities.');
  const obj=raw as Record<string,unknown>;
  let sum=0;
  for(const key of labels){const n=obj[key];if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>1)throw new JevascriptError('Judge returned invalid probabilities.');sum+=n;}
  if(Math.abs(sum-1)>.02)throw new JevascriptError('Judge probabilities do not sum to one.');
  return Object.fromEntries(labels.map(label=>[label,(obj[label] as number)/sum]));
}

type Handlers<R> = {yes?:()=>R|Promise<R>; maybe?:()=>R|Promise<R>; no?:()=>R|Promise<R>};

/** Result of `feels`. Tri-state: the DSL's if / otherwise maybe / else. */
export class Feeling {
  constructor(readonly verdict:Verdict, readonly probability:number, readonly probabilities:Record<string,number>, readonly threshold:number, readonly sampled:boolean) {}
  get yes(){return this.verdict==='yes';}
  get no(){return this.verdict==='no';}
  get maybe(){return this.verdict==='maybe';}
  /** Run the handler for the verdict. A missing `maybe` handler runs nothing, like an `if` without `otherwise maybe`. */
  async when<R>(h:Handlers<R>):Promise<R|undefined>{return h[this.verdict]?.();}
}
export type FeelingPromise = Promise<Feeling>&{when<R>(h:Handlers<R>):Promise<R|undefined>};

export class Jevascript {
  readonly output:string[]=[];
  readonly tape:Effect[]=[];
  readonly trace:Trace[]=[];
  private calls=0;
  private readonly consumed=new Set<number>();
  private readonly signal:AbortSignal;
  private readonly chaosScope=new AsyncLocalStorage<boolean>();
  constructor(private readonly o:Options) {
    const timeout=AbortSignal.timeout(o.timeoutMs??90_000);
    this.signal=o.signal?AbortSignal.any([o.signal,timeout]):timeout;
  }
  private get chaotic(){return this.chaosScope.getStore()===true;}
  private emit(e:Trace){this.trace.push(e);this.o.onEvent?.(e);}

  /** Every model effect goes through here: budget, replay lookup, tape. */
  private async effect(kind:Effect['kind'], args:unknown, call:()=>Promise<unknown>, chaos=false):Promise<Effect> {
    this.signal.throwIfAborted();
    if(++this.calls>(this.o.maxCalls??12))throw new JevascriptError(`Run stopped at the ${this.o.maxCalls??12} model-call limit.`);
    let e:Effect;
    if(this.o.replay) {
      const key=JSON.stringify(args);
      const i=this.o.replay.findIndex((s,i)=>!this.consumed.has(i)&&s.kind===kind&&JSON.stringify(s.args)===key);
      if(i===-1)throw new JevascriptError('Replay does not match this program and input.');
      this.consumed.add(i);e=structuredClone(this.o.replay[i]);
    } else {
      e={kind,args,result:await call(),...(chaos?{draw:(this.o.random||Math.random)()}:{})};
    }
    if(chaos&&(typeof e.draw!=='number'||e.draw<0||e.draw>=1))throw new JevascriptError('Invalid chaos draw in replay.');
    this.tape.push(e);return e;
  }

  /** Lowest-level judgment: pick among labels. Returns null when the winner's probability is under `confidence`. */
  async classify(value:Value, labels:string[], confidence=0):Promise<{label:string|null; probabilities:Record<string,number>; draw?:number}> {
    if(labels.length<2||labels.length>8)throw new JevascriptError('classify/match needs 2 to 8 labels.');
    if(confidence<0||confidence>1)throw new JevascriptError('confidence must be between 0 and 1.');
    const chaos=this.chaotic;
    const record=await this.effect('judge',{value,labels},()=>this.o.provider.judge(value,labels,this.signal),chaos);
    const probabilities=distribution(record.result,labels);
    let chosen=labels.reduce((best,label)=>probabilities[label]>probabilities[best]?label:best,labels[0]);
    const uncertain=probabilities[chosen]<confidence;
    if(chaos&&!uncertain){let remaining=record.draw!;chosen=labels[labels.length-1];for(const label of labels){remaining-=probabilities[label];if(remaining<0){chosen=label;break;}}}
    this.emit({kind:'judge',text:uncertain?'Uncertain → otherwise maybe':`${chosen} → ${Math.round(probabilities[chosen]*100)}%${chaos?' · sampled':' · highest probability'}`,detail:{value,probabilities,chosen:uncertain?null:chosen,threshold:confidence,...(chaos?{draw:record.draw}:{})}});
    return {label:uncertain?null:chosen,probabilities,draw:record.draw};
  }

  /** `if value feels "question" with confidence X%`. Default 50% like probably. */
  feels(value:Value, question:string, {confidence=.5}:{confidence?:number}={}):FeelingPromise {
    const yes=question, no=`NOT: ${question}`;
    const p=this.classify(value,[yes,no],confidence).then(r=>new Feeling(r.label===null?'maybe':r.label===yes?'yes':'no',r.probabilities[yes],r.probabilities,confidence,this.chaotic));
    return Object.assign(p,{when:<R>(h:Handlers<R>)=>p.then(f=>f.when(h))});
  }

  /** `match value { "label" => {...} }`. Highest probability wins; ties go to the first label; no uncertainty branch. */
  async match<H extends Record<string,()=>unknown>>(value:Value, handlers:H):Promise<Awaited<ReturnType<H[keyof H]>>> {
    const labels=Object.keys(handlers);
    const {label}=await this.classify(value,labels,0);
    return (await handlers[label!]()) as Awaited<ReturnType<H[keyof H]>>;
  }

  /** `while value feels "question" { ... }` as an async iterator. Re-judges the getter's current value before each
   *  iteration; throws if still true after `max` bodies (default 5), like probably. */
  async *whileFeels(value:()=>Value, question:string, {confidence=.5,max=this.o.maxLoop??5}:{confidence?:number; max?:number}={}):AsyncGenerator<number> {
    let i=0;
    while(true) {
      const f=await this.feels(value(),question,{confidence});
      if(!f.yes)return;
      if(i===max)throw new JevascriptError(`Loop still feels true after ${max} iterations. Try a different rewrite instruction.`);
      this.emit({kind:'repeat',text:`Iteration ${++i} of at most ${max}`});
      yield i;
    }
  }

  /** `llm "instruction" using context`. The model sees only what you pass. */
  async llm(prompt:string, context?:Value):Promise<string> {
    const args={prompt,...(context===undefined?{}:{value:context})};
    const record=await this.effect('write',args,()=>this.o.provider.write(prompt,context,this.signal));
    if(typeof record.result!=='string'||record.result.length>12000)throw new JevascriptError('Writer returned invalid or oversized text.');
    this.emit({kind:'write',text:record.result,detail:args});return record.result;
  }

  /** `chaos { ... }`: inside, judgments are sampled from their probabilities instead of taking the argmax
   *  (after the confidence gate, like probably). Scope follows async control flow, so nested awaits count. */
  chaos<R>(body:()=>Promise<R>|R):Promise<R>{return this.chaosScope.run(true,async()=>body());}

  /** `repeat n { ... }`. Just a loop, kept for trace parity. */
  async repeat(count:number, body:(i:number)=>unknown):Promise<void> {
    for(let i=0;i<count;i++){this.emit({kind:'repeat',text:`Iteration ${i+1} of ${count}`});await body(i);}
  }

  print(value:Value):void{const text=String(value);this.output.push(text);this.emit({kind:'print',text});}

  /** Assert a replay tape was fully used. */
  finish():void{if(this.o.replay&&this.consumed.size!==this.o.replay.length)throw new JevascriptError('Replay has unused model results.');}
}

export type Program = (p:Jevascript, input:string)=>Promise<unknown>|unknown;

/** Run a program to a recordable Run, like probably's `run(source, provider, options)`. */
export async function run(program:Program, options:Options&{input?:string; name?:string}):Promise<Run> {
  const input=options.input??'';
  if(input.length>6000)throw new JevascriptError('Input exceeds 6,000 characters.');
  const p=new Jevascript(options);
  await program(p,input);
  p.finish();
  return {version:1,program:options.name??program.name,input,tape:p.tape,output:p.output,trace:p.trace};
}
