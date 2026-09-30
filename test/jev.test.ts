// The jev CLI against a fake systemone, run as a subprocess. No model calls.
import {test,expect,afterAll} from 'bun:test';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {judgeRequest} from '../src/providers';
import {jev,scratch,sh,tape} from './cli';

// A fake systemone that checks each request against https://docs.typesafe.ai/api, then answers from the text a
// question judges (the line it points at, or the state). Noul: .95 when the text says "urgent", .6 when it says "meh",
// else .05; probably's "q" vs "NOT: q" choice the same. Other choices: .7 on the first option whose description (or
// key) ends in a word the text contains, the rest shared; uniform when none does.
type Question = {type:string; instructions?:unknown; criteria?:any};
type Body = {model:string; state:any; questions:Record<string,Question>};
const seen:Body[]=[],paths:string[]=[];
let failures:number[]=[];  // statuses to send before answering, to exercise retries
function invalid(body:Body):string|undefined {
  if(typeof body.model!=='string'||!body.model)return 'model is required';
  if(body.state===undefined||body.state===null)return 'state is required';
  if(!body.questions||!Object.keys(body.questions).length)return 'questions are required';
  for(const [name,q] of Object.entries(body.questions)) {
    if(q.instructions===undefined||q.instructions==='')return `${name}: instructions are required`;
    if(q.type==='noul'){if(q.criteria!==undefined&&Object.keys(q.criteria).some(k=>k!=='true'&&k!=='false'))return `${name}: noul criteria are true/false`;}
    else if(q.type==='choice'){const n=Object.keys(q.criteria??{}).length;if(n<1||n>255)return `${name}: a choice takes 1 to 255 options`;}
    else return `${name}: unknown type ${q.type}`;
  }
}
const server=Bun.serve({port:0,async fetch(request) {
  paths.push(new URL(request.url).pathname);
  if(request.headers.get('authorization')!=='Bearer test')return new Response('bad key',{status:401});
  const body=await request.json() as Body;seen.push(body);
  const status=failures.shift();
  if(status)return new Response('busy',{status,headers:{'retry-after-ms':'5'}});
  const problem=invalid(body)??(JSON.stringify(body.state).includes('FAIL')?'state says FAIL':undefined);
  if(problem)return Response.json({detail:problem},{status:422});
  const yes=(text:string)=>text.includes('urgent')?.95:text.includes('meh')?.6:.05;
  return Response.json({model:body.model,usage:{input_tokens:1,output_tokens:1},answers:Object.fromEntries(Object.entries(body.questions).map(([name,q])=>{
    const line=/`lines\[(\d+)\]`/.exec(String(q.instructions));
    const text=String(line?body.state.lines[Number(line[1])]:typeof body.state==='string'?body.state:body.state.value??JSON.stringify(body.state)).toLowerCase();
    if(q.type==='noul')return [name,{type:'noul',noul:yes(text)}];
    const keys=Object.keys(q.criteria),labels=keys.map(k=>String(q.criteria[k]??k));
    let ps:number[];
    if(labels[1]?.startsWith('NOT: '))ps=[yes(text),1-yes(text)];
    else {const w=labels.findIndex(l=>text.includes(l.split(' ').at(-1)!.toLowerCase()));ps=labels.map((_,i)=>w===-1?1/labels.length:i===w?.7:.3/(labels.length-1));}
    return [name,{type:'choice',choice:keys[ps.indexOf(Math.max(...ps))],probabilities:Object.fromEntries(keys.map((k,i)=>[k,ps[i]])),confidence:.5}];
  }))});
}});
afterAll(()=>server.stop());
const live={TYPESAFE_API_KEY:'test',TYPESAFE_BASE_URL:server.url.href,TYPESAFE_DEFAULT_MODEL:'jev-test'};
const run=(args:string[],stdin='',env:Record<string,string>={})=>jev(args,{stdin,env:{...live,...env}});

test('feels prints the verdict and exits with it; maybe needs a confidence gate',async()=>{
  seen.length=0;
  expect(await run(['feels','urgent'],'this is URGENT\n\n')).toMatchObject({out:'yes\n',code:0});
  expect(seen[0]).toEqual({model:'jev-test',...judgeRequest('this is URGENT',['urgent','NOT: urgent'])} as any);
  expect(await run(['feels','urgent'],'lunch?')).toMatchObject({out:'no\n',code:1});
  expect(await run(['feels','urgent'],'meh')).toMatchObject({out:'yes\n',code:0});
  for(const c of ['80','80%','.8'])expect(await run(['feels','-c',c,'urgent'],'meh')).toMatchObject({out:'maybe\n',code:3});
  expect(await run(['feels','-q','-c','80','urgent'],'meh')).toMatchObject({out:'',code:3});
  expect(await run(['feels','-p','urgent'],'URGENT')).toMatchObject({out:'0.950\tyes\n',code:0});
});

test('env follows the TypeSafe SDKs: TYPESAFE_API_KEY, TYPESAFE_BASE_URL (the API root), TYPESAFE_DEFAULT_MODEL',async()=>{
  seen.length=0;paths.length=0;
  expect((await run(['feels','urgent'],'URGENT',{TYPESAFE_BASE_URL:`${server.url.href}//`,TYPESAFE_DEFAULT_MODEL:' '})).code).toBe(0);
  expect(paths).toEqual(['/v1/systemone']);expect(seen[0].model).toBe('jev-latest');
  const old=await jev(['feels','urgent'],{stdin:'x',env:{JEV_API_KEY:'test',JEV_URL:server.url.href}});
  expect(old.code).toBe(2);expect(old.err).toContain('No judge (TYPESAFE_API_KEY)');
});

test('errors exit 2, so they never read as no; the API\'s detail comes through',async()=>{
  const failed=await run(['feels','urgent'],'FAIL');
  expect(failed.code).toBe(2);expect(failed.err).toContain('Jev request failed (422): {"detail":"state says FAIL"}');
  expect((await run(['feels','urgent'],'x',{TYPESAFE_API_KEY:'wrong'})).err).toContain('(401)');
  for(const args of [['feels','a','b'],['feels','-c','180','a'],['feels','--chaos','--no-chaos','a'],['grep','-z','a'],['grep','--batch','0','a'],['nope'],[]])
    expect((await run(args,'x')).code).toBe(2);
});

test('retries 408, 429 and 5xx like the SDKs (twice, honoring retry-after-ms), but not 4xx',async()=>{
  seen.length=0;failures=[429,529];
  expect(await run(['feels','urgent'],'URGENT')).toMatchObject({out:'yes\n',code:0});
  expect(seen).toHaveLength(3);
  seen.length=0;failures=[503,503,503];
  const out=await run(['grep','urgent'],'URGENT\n');
  expect(out.code).toBe(2);expect(out.err).toContain('(503)');expect(seen).toHaveLength(3);
  seen.length=0;failures=[];
  await run(['feels','urgent'],'FAIL');expect(seen).toHaveLength(1);
});

test('match prints the chosen key (or label), and exits 3 under the gate',async()=>{
  expect(await run(['match','bug=a bug','idea=an idea'],'found a bug')).toMatchObject({out:'bug\n',code:0});
  expect(await run(['match','a bug','an idea'],'an idea!')).toMatchObject({out:'an idea\n',code:0});
  expect(await run(['match','-p','bug=a bug','idea=an idea'],'idea')).toMatchObject({out:'0.700\tidea\n',code:0});
  expect(await run(['match','-c','80','bug=a bug','idea=an idea'],'found a bug')).toMatchObject({out:'',code:3});
  for(const args of [['match','only'],['match','a=x','a=y'],['match','a=x','b=x']])expect((await run(args,'x')).code).toBe(2);
});

test('grep asks a Noul per line, pointing at it by path, and prints the lines that fit',async()=>{
  const log='boot ok\nURGENT: disk full\nmeh\ncert URGENT\n';
  seen.length=0;
  expect(await run(['grep','urgent'],log)).toMatchObject({out:'URGENT: disk full\nmeh\ncert URGENT\n',code:0});
  expect(seen[0].state).toEqual({lines:['boot ok','URGENT: disk full','meh','cert URGENT']});
  expect(seen[0].questions.L2).toEqual({type:'noul',instructions:'Does `lines[1]` match this description: "urgent"?'});
  expect(await run(['grep','-c','80','-n','-p','urgent'],log)).toMatchObject({out:'0.950\t2:URGENT: disk full\n0.950\t4:cert URGENT\n',code:0});
  expect(await run(['grep','-v','-c','80','urgent'],log)).toMatchObject({out:'boot ok\n',code:0});  // meh is a maybe: neither
  expect(await run(['grep','-q','urgent'],log)).toMatchObject({out:'',code:0});
  expect(await run(['grep','urgent'],'calm\n')).toMatchObject({out:'',code:1});
});

test('grep batches by the documented token budget, not a question count; --batch caps it',async()=>{
  const short=Array.from({length:120},(_,i)=>i%10?`line ${i}`:`URGENT ${i}`).join('\n');
  seen.length=0;
  expect((await run(['grep','urgent'],short)).out.split('\n').filter(Boolean)).toHaveLength(12);
  expect(seen.map(b=>Object.keys(b.questions).length)).toEqual([120]);
  seen.length=0;
  await run(['grep','--batch','50','urgent'],short);
  expect(seen.map(b=>Object.keys(b.questions).length).sort()).toEqual([20,50,50]);  // batches run concurrently
  const long=Array.from({length:300},(_,i)=>`${i} ${'x'.repeat(600)}`);
  seen.length=0;
  expect((await run(['grep','urgent'],long.join('\n'))).code).toBe(1);
  expect(seen.length).toBeGreaterThanOrEqual(3);
  for(const body of seen)expect(Buffer.byteLength(JSON.stringify(body.state))/3).toBeLessThan(28000);
  expect(seen.flatMap(b=>b.state.lines).sort()).toEqual([...long].sort());
});

test('ask sends every question in one call: Nouls and Choices keyed by your keys',async()=>{
  seen.length=0;
  const kind="kind: bug=a bug | it's an idea";
  expect(await run(['ask','-p','urgent? Does this need a reply today?','ask? Is it urgent?',kind],'URGENT bug')).toMatchObject({code:0,
    out:'urgent=yes\nurgent_p=0.950\nask=yes\nask_p=0.950\nkind=bug\nkind_p=0.700\n'});
  expect(seen).toHaveLength(1);
  expect(seen[0].state).toBe('URGENT bug');
  expect(seen[0].questions).toEqual({
    urgent:{type:'noul',instructions:'Does this need a reply today?'},
    ask:{type:'noul',instructions:'Is it urgent?'},
    kind:{type:'choice',instructions:'Which option best describes this?',criteria:{bug:'a bug',"it's an idea":null}},
  });
  await run(['ask','team: Which team should handle this? billing=payments, refunds | technical=bugs, outages | other'],'refunds');
  expect(seen[1].questions.team).toEqual({type:'choice',instructions:'Which team should handle this?',criteria:{billing:'payments, refunds',technical:'bugs, outages',other:null}});
  const quoted=await sh(['bash','-c',`eval "$(jev ask 'urgent? Is it urgent?' "${kind}")"; printf '%s|%s' "$urgent" "$kind"`],{stdin:'an idea',env:live});
  expect(quoted).toMatchObject({out:"no|it's an idea",code:0});
  expect(await run(['ask','-c','80','urgent? Is it urgent?',kind],'meh')).toMatchObject({out:"urgent=maybe\nkind=''\n",code:3});
  const json=JSON.parse((await run(['ask','--json','urgent? Is it urgent?',kind],'URGENT bug')).out);
  expect(json.urgent).toMatchObject({answer:'yes',probability:.95});
  expect(json.kind.answer).toBe('bug');expect(Object.keys(json.kind.probabilities)).toEqual(['bug',"it's an idea"]);
  for(const args of [['ask'],['ask','bad spec'],['ask','a? x','a? y'],['ask','a: one']])expect((await run(args,'x')).code).toBe(2);
  expect((await run(['ask','a? x'],'')).code).toBe(2);  // nothing to judge
});

test('ask -f builds a structured state, with stdin under value',async()=>{
  const dir=scratch();writeFileSync(join(dir,'x.patch'),'- old\n+ URGENT\n');writeFileSync(join(dir,'m.json'),'{"n":1}');
  seen.length=0;
  expect(await run(['ask','-f',`diff=@${join(dir,'x.patch')}`,'risky? Is `diff` a risky change?'])).toMatchObject({out:'risky=yes\n',code:0});
  expect(seen[0].state).toEqual({diff:'- old\n+ URGENT'});
  await run(['ask','-f','title=hi','-f','n:=3','-f',`meta:=@${join(dir,'m.json')}`,'kind: a | b'],'body');
  expect(seen[1].state).toEqual({value:'body',title:'hi',n:3,meta:{n:1}});
  expect(seen[1].questions.kind.instructions).toBe('Which option best describes the state?');
});

test('--dry-run prints the request; raw sends one',async()=>{
  const request=(await run(['feels','urgent','--dry-run'],'URGENT')).out;
  expect(JSON.parse(request)).toEqual(judgeRequest('URGENT',['urgent','NOT: urgent']));
  seen.length=0;
  const response=JSON.parse((await run(['raw'],request)).out);
  expect(response.answers.decision.probabilities.option_0).toBe(.95);
  expect(seen).toEqual([{model:'jev-test',...JSON.parse(request)}]);
  expect((await run(['grep','urgent','--dry-run'],'a\nb\n')).out.trim().split('\n')).toHaveLength(1);
  expect(seen).toHaveLength(1);
});

test('chaos comes from --chaos or JEV_CHAOS, --no-chaos opts out, and each sampled judgment records its draw',async()=>{
  const file=join(scratch(),'t.jsonl');
  const draws=async(args:string[],env:Record<string,string>={})=>{
    writeFileSync(file,'');await run(args,'URGENT',{...env,JEV_RECORD:file});
    return tape(file).map(e=>e.draw??e.draws);
  };
  expect(await draws(['feels','urgent'])).toEqual([undefined]);
  expect(typeof (await draws(['feels','--chaos','urgent']))[0]).toBe('number');
  expect(typeof (await draws(['match','a=x','b=y'],{JEV_CHAOS:'1'}))[0]).toBe('number');
  expect(await draws(['feels','--no-chaos','urgent'],{JEV_CHAOS:'1'})).toEqual([undefined]);
  expect(await draws(['feels','urgent'],{JEV_CHAOS:'0'})).toEqual([undefined]);
  expect(Object.keys((await draws(['ask','--chaos','a? x','b? y']))[0])).toEqual(['a','b']);
});

test('record and replay wrap a whole script; replay needs no key and makes no calls',async()=>{
  const file=join(scratch(),'t.jsonl');
  const script=`read -r m; jev feels urgent <<<"$m"; printf 'a\\nURGENT b\\n' | jev grep urgent; jev ask 'k: bug=a bug | idea=an idea' <<<"$m"`;
  const first=await run(['record',file,'--','bash','-c',script],'URGENT bug');
  expect(first).toMatchObject({out:'yes\nURGENT b\nk=bug\n',code:0});
  expect(tape(file).map(e=>e.kind)).toEqual(['judge','systemone','systemone']);
  seen.length=0;
  expect(await jev(['replay',file,'--','bash','-c',script],{stdin:'URGENT bug'})).toMatchObject({out:first.out,code:0});
  expect(seen).toHaveLength(0);
  const other=await jev(['replay',file,'--','bash','-c',script],{stdin:'calm'});
  expect(other.code).toBe(2);expect(other.err).toContain('does not match');expect(other.err).toContain('2 unused');
  const partial=await jev(['replay',file,'--','bash','-c','read -r m; jev feels urgent <<<"$m"'],{stdin:'URGENT bug'});
  expect(partial).toMatchObject({out:'yes\n',code:2});expect(partial.err).toContain('2 unused model results');
  expect((await jev(['feels','urgent'],{stdin:'x',env:{JEV_REPLAY:file}})).err).toContain('jev replay FILE');
});

test('replay shares one tape across concurrent processes, one effect each',async()=>{
  const file=join(scratch(),'t.jsonl');
  await run(['record',file,'--','bash','-c','for i in 1 2 3; do jev feels urgent <<<URGENT; done']);
  const r=await jev(['replay',file,'--','bash','-c','for i in 1 2 3; do jev feels urgent <<<URGENT & done; wait']);
  expect(r).toMatchObject({out:'yes\nyes\nyes\n',code:0});
  expect((await jev(['replay',file,'--','bash','-c','for i in 1 2 3 4; do jev feels urgent <<<URGENT; done'])).code).toBe(2);
});

test('replay takes the recorded chaos draw',async()=>{
  const file=join(scratch(),'t.jsonl');
  writeFileSync(file,JSON.stringify({kind:'judge',args:{value:'x',labels:['urgent','NOT: urgent']},result:{urgent:.95,'NOT: urgent':.05},draw:.97})+'\n');
  expect(await jev(['replay',file,'--','jev','feels','--chaos','urgent'],{stdin:'x'})).toMatchObject({out:'no\n',code:1});
});

test('run runs a jevascript program, like the old cli',async()=>{
  const examples=join(import.meta.dir,'../examples');
  expect(await run(['run',join(examples,'urgent.ts'),'URGENT, now'])).toMatchObject({out:'Okay. This is a drop-everything situation.\n',code:0});
  expect((await jev(['run',join(examples,'hello.ts')])).out.split('\n')).toHaveLength(5);
});

test('--skill prints an agent skill that covers every command',async()=>{
  const skill=(await jev(['--skill'])).out;
  expect(skill).toBe(readFileSync(join(import.meta.dir,'../skills/jev/SKILL.md'),'utf8'));
  expect(skill).toStartWith('---\nname: jev\ndescription: ');
  const commands=[...(await jev(['--help'])).out.matchAll(/^  jev (\w+)/gm)].map(m=>m[1]);
  expect(commands).toEqual(['feels','match','grep','ask','raw','run','record','replay']);
  for(const command of commands)expect(skill).toContain(`jev ${command}`);
});
