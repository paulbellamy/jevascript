#!/usr/bin/env bun
// jev: jevascript's judgments from the shell. Questions are arguments; the value to judge comes on stdin.
// feels / match / run go through the library's Provider; grep / ask / raw talk to systemone directly, so one call
// can carry many questions. record / replay wrap a whole command, so every jev call inside it shares one tape.
import {parseArgs} from 'node:util';
import {isatty} from 'node:tty';
import {appendFileSync,closeSync,mkdtempSync,openSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {decide,Jevascript,JevascriptError,type Provider} from './jevascript';
import {record,replay,type Effect,type Recording} from './recording';
import {answer,choice,fromEnv,jevConfig,judgeRequest,systemOne,type Request,type Response} from './providers';
import skill from '../skills/jev/SKILL.md' with {type:'text'};

const USAGE=`usage: jev COMMAND [options] ...     (the value to judge comes on stdin)

  jev feels [-c 80] [-q] [-p] QUESTION          prints yes|no|maybe, exits 0|1|3
  jev match [-c 80] [-p] LABEL|KEY=LABEL ...    prints the chosen key, exits 3 if unsure
  jev grep  [-c 80] [-q] [-p] [-v] [-n] QUESTION
                                                prints the lines that fit, judged in batches
  jev ask   [-c 80] [-p] [--json] [-f K=V|K=@FILE|K:=JSON]... 'NAME? QUESTION' 'NAME: A | KEY=B'
                                                prints NAME=answer lines, for eval
  jev raw                                       sends a systemone request, prints the response
  jev run PROGRAM.ts [INPUT]                    runs a jevascript program
  jev record FILE -- COMMAND ...                records every jev call COMMAND makes
  jev replay FILE -- COMMAND ...                replays them: no keys, no model calls
  jev --skill                                   prints the agent skill for using jev

  -c N         confidence gate: 80, 80% or .8
  -p           prefix a probability column
  --chaos      sample instead of taking the argmax (default: JEV_CHAOS); --no-chaos to opt out
  --dry-run    print the request instead of sending it (jev raw sends it)

  exit 2 is an error. env: JEV_API_KEY, JEV_MODEL, JEV_URL, JEV_CHAOS`;

const YES=0,NO=1,ERROR=2,UNSURE=3;
class UsageError extends Error {}
const out=(line:string)=>console.log(line);
const fmt=(p:number)=>p.toFixed(3);

// ---- model access: live, or replaying JEV_REPLAY; recording to JEV_RECORD --------------------------------------

/** A direct systemone call (grep, ask, raw), with each question's chaos draw when sampled. */
type Call = {kind:'systemone'; args:Request; result:Response; draws?:Record<string,number>};
type Tape = (Effect|Call)[];
type Session = {provider:Provider; ask(request:Request, sample:boolean):Promise<{response:Response; draws?:Record<string,number>}>; save():void};

/** JSON lines, one effect each (what `jev record` writes), or a JSON array (probably's tape). */
function readTape(file:string):Tape {
  const text=readFileSync(file,'utf8');
  return text.trimStart().startsWith('[')?JSON.parse(text):text.split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line));
}

/** Claim effect i of a shared tape by creating a file named i in `dir`. Creation is atomic, so exactly one process
 *  gets each effect, with no locks to leak. */
const claimer=(dir:string)=>(i:number)=>{
  try{closeSync(openSync(join(dir,String(i)),'wx'));return true;}
  catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return false;throw error;}
};

function session(env=process.env):Session {
  let provider:Provider, ask:Session['ask'];
  if(env.JEV_REPLAY) {
    if(!env.JEV_REPLAY_CLAIMS)throw new UsageError('JEV_REPLAY is set by `jev replay FILE -- COMMAND`; run under that.');
    const tape=readTape(env.JEV_REPLAY),claim=claimer(env.JEV_REPLAY_CLAIMS);
    provider=replay(tape as Recording,claim);
    ask=async(args,sample)=>{
      const key=JSON.stringify(args);
      const i=tape.findIndex((e,i)=>e.kind==='systemone'&&JSON.stringify(e.args)===key&&claim(i));
      if(i===-1)throw new JevascriptError('Recording does not match this program and input.');
      const {result,draws}=tape[i] as Call;
      if(sample&&!draws)throw new JevascriptError('Recording has no chaos draw for this judgment.');
      return {response:result,draws};
    };
  } else {
    provider=fromEnv(env);
    const jev=jevConfig(env),post=jev&&systemOne(jev);
    ask=async(args,sample)=>{
      if(!post)throw new Error('No judge (JEV_API_KEY) configured. See README.');
      return {response:await post(args),draws:sample?Object.fromEntries(Object.keys(args.questions).map(name=>[name,Math.random()])):undefined};
    };
  }
  if(!env.JEV_RECORD)return {provider,ask,save(){}};
  const live=record(provider),tape:Tape=live.recording,file=env.JEV_RECORD,inner=ask;
  return {
    provider:live,
    async ask(args,sample){const r=await inner(args,sample);tape.push({kind:'systemone',args,result:r.response,...(r.draws?{draws:r.draws}:{})});return r;},
    save(){if(tape.length)appendFileSync(file,tape.map(e=>JSON.stringify(e)+'\n').join(''));},
  };
}

// ---- arguments ---------------------------------------------------------------------------------------------------

const judging={confidence:{type:'string',short:'c'},chaos:{type:'boolean'},'no-chaos':{type:'boolean'},'dry-run':{type:'boolean'},probability:{type:'boolean',short:'p'}} as const;
const quiet={quiet:{type:'boolean',short:'q'}} as const;
type Options = Parameters<typeof parseArgs>[0] extends infer C ? C extends {options?:infer O} ? NonNullable<O> : never : never;
const parse=<O extends Options>(args:string[],options:O)=>parseArgs({args,options,allowPositionals:true,strict:true});

const truthy=(v?:string)=>!!v&&!/^(0|false|no|off)$/i.test(v);
function chaotic(values:{chaos?:boolean; 'no-chaos'?:boolean}):boolean {
  if(values.chaos&&values['no-chaos'])throw new UsageError('--chaos and --no-chaos conflict.');
  return values.chaos?true:values['no-chaos']?false:truthy(process.env.JEV_CHAOS);
}
/** 80, 80% and .8 all mean 80%. */
function confidence(s:string|undefined,fallback:number):number {
  if(s===undefined)return fallback;
  const m=/^(\d+(?:\.\d+)?|\.\d+)(%?)$/.exec(s),n=m?Number(m[1])/(m[2]||Number(m[1])>1?100:1):NaN;
  if(!(n>=0&&n<=1))throw new UsageError(`-c takes a confidence like 80, 80% or .8, not ${JSON.stringify(s)}.`);
  return n;
}
function one(positionals:string[],what:string):string {
  if(positionals.length!==1)throw new UsageError(`expected ${what} as one argument (quote it), got ${positionals.length}.`);
  return positionals[0];
}
/** `key=label` answers with key; a bare label answers with itself. */
const KEYED=/^([A-Za-z_][\w-]*)=([\s\S]+)$/;
type Label = {key:string; label:string};
function labels(args:string[]):Label[] {
  const ls=args.map(arg=>{const m=KEYED.exec(arg);return m?{key:m[1],label:m[2]}:{key:arg,label:arg};});
  if(ls.length<2)throw new UsageError('give at least two labels.');
  for(const k of ['key','label'] as const)if(new Set(ls.map(l=>l[k])).size<ls.length)throw new UsageError(`duplicate ${k}s in ${JSON.stringify(args)}.`);
  return ls;
}
const yesNo=(question:string)=>[question,`NOT: ${question}`];
const verdict=(chosen:string|null,question:string)=>chosen===null?'maybe':chosen===question?'yes':'no';

async function stdin():Promise<string> {
  if(isatty(0))throw new UsageError('pipe the value to judge on stdin, e.g. jev feels "urgent" <<<"$message".');
  return await Bun.stdin.text();
}
/** Like $(…): trailing newlines are not part of the value. */
const trim=(text:string)=>text.replace(/\n+$/,'');
const within=<R>(p:Jevascript,chaos:boolean,body:()=>Promise<R>)=>chaos?p.chaos(body):body();

// ---- commands ----------------------------------------------------------------------------------------------------

async function feels(args:string[],s:Session):Promise<number> {
  const {values,positionals}=parse(args,{...judging,...quiet});
  const question=one(positionals,'a question'),c=confidence(values.confidence,.5),value=trim(await stdin());
  if(values['dry-run']){out(JSON.stringify(judgeRequest(value,yesNo(question))));return YES;}
  const p=new Jevascript(s.provider);
  const f=await within(p,chaotic(values),()=>p.feels(value,question,{confidence:c}));
  if(!values.quiet)out(values.probability?`${fmt(f.probability)}\t${f.verdict}`:f.verdict);
  return f.yes?YES:f.no?NO:UNSURE;
}

async function match(args:string[],s:Session):Promise<number> {
  const {values,positionals}=parse(args,judging);
  const ls=labels(positionals),c=confidence(values.confidence,0),value=trim(await stdin());
  if(values['dry-run']){out(JSON.stringify(judgeRequest(value,ls.map(l=>l.label))));return YES;}
  const p=new Jevascript(s.provider);
  const r=await within(p,chaotic(values),()=>p.classify(value,ls.map(l=>l.label),c));
  if(r.label===null)return UNSURE;
  const key=ls.find(l=>l.label===r.label)!.key;
  out(values.probability?`${fmt(r.probabilities[r.label])}\t${key}`:key);
  return YES;
}

/** Lines go into the state as {lines:{L1,L2,…}} with one question per line, up to a batch per call. */
const LINES_PER_CALL=50,CHARS_PER_CALL=64000,PARALLEL_CALLS=4;
function batches(lines:string[]):number[][] {
  const all:number[][]=[];let batch:number[]=[],chars=0;
  lines.forEach((line,i)=>{
    if(batch.length&&(batch.length===LINES_PER_CALL||chars+line.length>CHARS_PER_CALL)){all.push(batch);batch=[];chars=0;}
    batch.push(i);chars+=line.length;
  });
  if(batch.length)all.push(batch);
  return all;
}
async function pool<T>(tasks:(()=>Promise<T>)[],n:number):Promise<T[]> {
  const results:T[]=new Array(tasks.length);let next=0;
  await Promise.all(Array.from({length:Math.min(n,tasks.length)},async()=>{while(next<tasks.length){const i=next++;results[i]=await tasks[i]();}}));
  return results;
}

async function grep(args:string[],s:Session):Promise<number> {
  const {values,positionals}=parse(args,{...judging,...quiet,invert:{type:'boolean',short:'v'},'line-number':{type:'boolean',short:'n'}});
  const question=one(positionals,'a question'),c=confidence(values.confidence,.5),ls=yesNo(question),chaos=chaotic(values);
  const lines=(await stdin()).split('\n');
  if(lines.at(-1)==='')lines.pop();
  const requests:Request[]=batches(lines).map(batch=>({
    state:{lines:Object.fromEntries(batch.map(i=>[`L${i+1}`,lines[i]]))},
    questions:Object.fromEntries(batch.map(i=>[`L${i+1}`,choice(ls,`line L${i+1}`)])),
  }));
  if(values['dry-run']){requests.forEach(r=>out(JSON.stringify(r)));return YES;}
  const results=await pool(requests.map(r=>()=>s.ask(r,chaos)),PARALLEL_CALLS);
  const wanted=values.invert?'no':'yes';let matched=0;
  results.forEach(({response,draws},b)=>{for(const name of Object.keys(requests[b].questions)) {
    const probabilities=answer(response,name,ls);
    if(verdict(decide(probabilities,ls,c,chaos?draws?.[name]:undefined),question)!==wanted)continue;
    matched++;
    if(!values.quiet)out(`${values.probability?`${fmt(probabilities[question])}\t`:''}${values['line-number']?`${name.slice(1)}:`:''}${lines[Number(name.slice(1))-1]}`);
  }});
  return matched?YES:NO;
}

/** `name? question` asks yes/no; `name: a | key=b | …` chooses. */
const SPEC=/^([A-Za-z_]\w*)\s*([?:])\s*([\s\S]+)$/;
type Spec = {name:string; yesNo:boolean; labels:Label[]};
function spec(arg:string):Spec {
  const m=SPEC.exec(arg);
  if(!m)throw new UsageError(`ask questions look like 'name? question' or 'name: label | key=label', not ${JSON.stringify(arg)}.`);
  const text=m[3].trim();
  return m[2]==='?'?{name:m[1],yesNo:true,labels:[{key:'yes',label:text},{key:'no',label:`NOT: ${text}`}]}:{name:m[1],yesNo:false,labels:labels(text.split('|').map(l=>l.trim()))};
}
/** -f key=value, key=@file (text), key:=json, key:=@file.json */
function field(arg:string):[string,unknown] {
  const m=/^([^=:@]+?)(:=|=)(@?)([\s\S]*)$/.exec(arg);
  if(!m)throw new UsageError(`-f takes key=value, key=@file, key:=json or key:=@file, not ${JSON.stringify(arg)}.`);
  const raw=m[3]?trim(readFileSync(m[4],'utf8')):m[4];
  return [m[1],m[2]===':='?JSON.parse(raw):raw];
}
const sh=(v:string)=>/^[\w.\/:+-]+$/.test(v)?v:`'${v.replaceAll("'",`'\\''`)}'`;

async function ask(args:string[],s:Session):Promise<number> {
  const {values,positionals}=parse(args,{...judging,json:{type:'boolean'},field:{type:'string',short:'f',multiple:true}});
  const specs=positionals.map(spec);
  if(!specs.length)throw new UsageError('ask needs at least one question.');
  if(new Set(specs.map(q=>q.name)).size<specs.length)throw new UsageError('ask question names must be unique.');
  const state:Record<string,unknown>={};
  if(!isatty(0)){const value=trim(await Bun.stdin.text());if(value)state.value=value;}
  for(const f of values.field??[]){const [k,v]=field(f);state[k]=v;}
  const keys=Object.keys(state);
  if(!keys.length)throw new UsageError('ask needs something to judge: pipe it on stdin, or pass -f key=value.');
  const subject=keys.length===1?keys[0]:'state';
  const request:Request={state,questions:Object.fromEntries(specs.map(q=>[q.name,choice(q.labels.map(l=>l.label),subject)]))};
  if(values['dry-run']){out(JSON.stringify(request));return YES;}
  const chaos=chaotic(values),{response,draws}=await s.ask(request,chaos);
  let unsure=false;
  const answers=specs.map(q=>{
    const ls=q.labels.map(l=>l.label),probabilities=answer(response,q.name,ls);
    const chosen=decide(probabilities,ls,confidence(values.confidence,q.yesNo?.5:0),chaos?draws?.[q.name]:undefined);
    unsure||=chosen===null;
    const top=ls.reduce((best,l)=>probabilities[l]>probabilities[best]?l:best);
    return {name:q.name,
      answer:chosen===null?(q.yesNo?'maybe':null):q.labels.find(l=>l.label===chosen)!.key,
      probability:probabilities[q.yesNo?ls[0]:chosen??top],
      probabilities:Object.fromEntries(q.labels.map(l=>[l.key,probabilities[l.label]]))};
  });
  if(values.json)out(JSON.stringify(Object.fromEntries(answers.map(({name,...a})=>[name,a]))));
  else for(const a of answers){out(`${a.name}=${sh(a.answer??'')}`);if(values.probability)out(`${a.name}_p=${fmt(a.probability)}`);}
  return unsure?UNSURE:YES;
}

async function raw(args:string[],s:Session):Promise<number> {
  parse(args,{});
  const {response}=await s.ask(JSON.parse(await stdin()) as Request,false);
  out(JSON.stringify(response));
  return YES;
}

async function run(args:string[],s:Session):Promise<number> {
  const {values,positionals}=parse(args,{chaos:judging.chaos,'no-chaos':judging['no-chaos']});
  if(positionals.length<1||positionals.length>2)throw new UsageError('jev run PROGRAM.ts [INPUT]');
  const program=(await import(resolve(positionals[0]))).default;
  const p=new Jevascript(s.provider);
  await within(p,chaotic(values),()=>program(p,positionals[1]??'',out));
  return YES;
}

async function wrap(mode:'record'|'replay',args:string[]):Promise<number> {
  const [file,...rest]=args,command=rest[0]==='--'?rest.slice(1):rest;
  if(!file||!command.length)throw new UsageError(`jev ${mode} FILE -- COMMAND ...`);
  const path=resolve(file);
  const spawn=(env:Record<string,string>)=>Bun.spawn(command,{stdio:['inherit','inherit','inherit'],env:{...process.env,...env}}).exited;
  if(mode==='record'){writeFileSync(path,'');return spawn({JEV_RECORD:path});}
  const effects=readTape(path).length,claims=mkdtempSync(join(tmpdir(),'jev-replay-'));
  try {
    const code=await spawn({JEV_REPLAY:path,JEV_REPLAY_CLAIMS:claims});
    const unused=effects-readdirSync(claims).length;
    if(unused>0){console.error(`jev: recording has ${unused} unused model result${unused===1?'':'s'}.`);return code||ERROR;}
    return code;
  } finally {rmSync(claims,{recursive:true,force:true});}
}

// ---- main --------------------------------------------------------------------------------------------------------

const commands:Record<string,(args:string[],s:Session)=>Promise<number>>={feels,match,grep,ask,raw,run};
const [command,...args]=process.argv.slice(2);
let s:Session|undefined;
try {
  if(command==='record'||command==='replay')process.exitCode=await wrap(command,args);
  else if(command==='help'||command==='-h'||command==='--help'){out(USAGE);process.exitCode=YES;}
  else if(command==='--skill'){process.stdout.write(skill);process.exitCode=YES;}
  else if(command&&Object.hasOwn(commands,command)){s=session();process.exitCode=await commands[command](args,s);}
  else if(command)throw new UsageError(`unknown command ${JSON.stringify(command)}.`);
  else {console.error(USAGE);process.exitCode=ERROR;}
} catch(error) {
  const usage=error instanceof UsageError||String((error as {code?:unknown})?.code).startsWith('ERR_PARSE_ARGS');
  console.error(`jev: ${error instanceof Error?error.message:error}`+(usage?'\nsee jev --help':''));
  process.exitCode=ERROR;
} finally {
  s?.save();
}
