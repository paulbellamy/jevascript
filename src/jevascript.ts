// jevascript: probably-lang's primitives as a plain TypeScript library. jev + javascript.
// feels / match / chaos / llm over one judgment call (classify). Recording is a provider wrapper; see recording.ts.
import {AsyncLocalStorage} from 'node:async_hooks';

export type Value = string|number|boolean;
/** A judgment: probabilities over the labels, plus a uniform draw when one was asked for (chaos). */
export type Judgment = {probabilities:Record<string,number>; draw?:number};
export interface Provider {
  /** Generate text. The model sees only the instruction and the context you pass. */
  write(prompt:string, context?:Value):Promise<string>;
  /** Judge which label fits the value. With `sample`, may also supply the draw used for sampling
   *  (a replaying provider must; a live one can leave it to the runtime). */
  judge(value:Value, labels:string[], options?:{sample?:boolean}):Promise<Judgment>;
}
export type Verdict = 'yes'|'maybe'|'no';
export class JevascriptError extends Error {}

/** Validate a distribution over the given labels; normalise to sum 1. Identical to probably's. */
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
  private readonly chaosScope=new AsyncLocalStorage<boolean>();
  constructor(private readonly provider:Provider) {}
  private get chaotic(){return this.chaosScope.getStore()===true;}

  /** The one judgment call. Argmax over labels (first label wins ties); null when the winner's probability is
   *  under `confidence`; inside `chaos`, sampled from the distribution once the gate passes. */
  async classify(value:Value, labels:string[], confidence=0):Promise<{label:string|null; probabilities:Record<string,number>; sampled:boolean}> {
    if(labels.length<2||labels.length>8)throw new JevascriptError('classify/match needs 2 to 8 labels.');
    if(confidence<0||confidence>1)throw new JevascriptError('confidence must be between 0 and 1.');
    const sample=this.chaotic;
    const judgment=await this.provider.judge(value,labels,{sample});
    const probabilities=distribution(judgment.probabilities,labels);
    let chosen=labels.reduce((best,label)=>probabilities[label]>probabilities[best]?label:best,labels[0]);
    const uncertain=probabilities[chosen]<confidence;
    if(sample&&!uncertain) {
      const draw=judgment.draw??Math.random();
      if(!(draw>=0&&draw<1))throw new JevascriptError('Invalid chaos draw.');
      let remaining=draw;chosen=labels[labels.length-1];
      for(const label of labels){remaining-=probabilities[label];if(remaining<0){chosen=label;break;}}
    }
    return {label:uncertain?null:chosen,probabilities,sampled:sample};
  }

  /** `if value feels "question" with confidence X%`. Default 50% like probably. */
  feels(value:Value, question:string, {confidence=.5}:{confidence?:number}={}):FeelingPromise {
    const yes=question, no=`NOT: ${question}`;
    const p=this.classify(value,[yes,no],confidence).then(r=>new Feeling(r.label===null?'maybe':r.label===yes?'yes':'no',r.probabilities[yes],r.probabilities,confidence,r.sampled));
    return Object.assign(p,{when:<R>(h:Handlers<R>)=>p.then(f=>f.when(h))});
  }

  /** `match value { "label" => {...} }`. Highest probability wins; ties go to the first label; no uncertainty branch. */
  async match<H extends Record<string,()=>unknown>>(value:Value, handlers:H):Promise<Awaited<ReturnType<H[keyof H]>>> {
    const {label}=await this.classify(value,Object.keys(handlers),0);
    return (await handlers[label!]()) as Awaited<ReturnType<H[keyof H]>>;
  }

  /** `chaos { ... }`: inside, judgments are sampled from their probabilities instead of taking the argmax
   *  (after the confidence gate, like probably). Scope follows async control flow, so nested awaits count. */
  chaos<R>(body:()=>Promise<R>|R):Promise<R>{return this.chaosScope.run(true,async()=>body());}

  /** `llm "instruction" using context`. The model sees only what you pass. */
  llm(prompt:string, context?:Value):Promise<string>{return this.provider.write(prompt,context);}
}
