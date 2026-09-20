// bun src/cli.ts examples/urgent.ts 'input text' [--record run.json]
// bun src/cli.ts --replay run.json
import {Jevascript} from './jevascript';
import {record,replay,type Recording} from './recording';
import {fromEnv} from './providers';
import {resolve} from 'node:path';
type Saved={version:1; program:string; input:string; recording:Recording; output:string[]};
const args=process.argv.slice(2),file=args[0];
if(!file){console.error('Usage: bun src/cli.ts examples/x.ts [input] [--record run.json]\n       bun src/cli.ts --replay run.json');process.exit(1);}
try {
  const output:string[]=[];const print=(s:string)=>{output.push(s);console.log(s);};
  if(file==='--replay') {
    const saved=await Bun.file(args[1]).json() as Saved;
    const provider=replay(saved.recording);
    await (await import(resolve(saved.program))).default(new Jevascript(provider),saved.input,print);
    provider.finish();
  } else {
    const input=args[1]?.startsWith('--')?'':args[1]||'';
    const provider=record(fromEnv());
    await (await import(resolve(file))).default(new Jevascript(provider),input,print);
    const save=args.indexOf('--record');
    if(save!==-1){if(!args[save+1])throw new Error('Missing recording file path.');await Bun.write(args[save+1],JSON.stringify({version:1,program:file,input,recording:provider.recording,output} satisfies Saved,null,2));}
  }
}catch(error){console.error(error instanceof Error?error.message:error);process.exitCode=1;}
