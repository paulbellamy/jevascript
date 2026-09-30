// Opt-in record / replay of model results, as provider wrappers. The runtime knows nothing about it.
// Effect shape is probably's, so probably's own recordings load unchanged.
import {type Provider,type Value,type Judgment,JevascriptError} from './jevascript';

export type Effect =
  | {kind:'judge'; args:{value:Value; labels:string[]}; result:Record<string,number>; draw?:number}
  | {kind:'write'; args:{prompt:string; value?:Value}; result:string};
export type Recording = Effect[];

const writeArgs=(prompt:string,value?:Value)=>({prompt,...(value===undefined?{}:{value})});

/** Wrap a live provider; every result (and chaos draw) is appended to `recording`. */
export function record(inner:Provider):Provider&{recording:Recording} {
  const recording:Recording=[];
  return {
    recording,
    async write(prompt,context){const result=await inner.write(prompt,context);recording.push({kind:'write',args:writeArgs(prompt,context),result});return result;},
    async judge(value,labels,options) {
      const j=await inner.judge(value,labels,options);
      const draw=options?.sample?(j.draw??Math.random()):undefined;
      recording.push({kind:'judge',args:{value,labels},result:j.probabilities,...(draw===undefined?{}:{draw})});
      return {probabilities:j.probabilities,draw};
    },
  };
}

/** A provider that answers from a recording and makes no model calls. Effects are matched by kind and args,
 *  first unconsumed wins, so order only matters between identical calls (and concurrent programs replay).
 *  `claim(i)` lets several replays share one recording (say, across processes): it marks effect i used and says
 *  whether it was still free. Call `finish()` to assert every recorded effect was used. */
export function replay(recording:Recording, claim:(i:number)=>boolean=()=>true):Provider&{finish():void} {
  const consumed=new Set<number>();
  const take=<K extends Effect['kind']>(kind:K,args:unknown):Extract<Effect,{kind:K}>=>{
    const key=JSON.stringify(args);
    const i=recording.findIndex((e,i)=>!consumed.has(i)&&e.kind===kind&&JSON.stringify(e.args)===key&&claim(i));
    if(i===-1)throw new JevascriptError('Recording does not match this program and input.');
    consumed.add(i);return structuredClone(recording[i]) as Extract<Effect,{kind:K}>;
  };
  return {
    async write(prompt,context){return take('write',writeArgs(prompt,context)).result;},
    async judge(value,labels,options):Promise<Judgment> {
      const e=take('judge',{value,labels});
      if(options?.sample&&!(typeof e.draw==='number'&&e.draw>=0&&e.draw<1))throw new JevascriptError('Recording has no chaos draw for this judgment.');
      return {probabilities:e.result,draw:e.draw};
    },
    finish(){if(consumed.size!==recording.length)throw new JevascriptError('Recording has unused model results.');},
  };
}
