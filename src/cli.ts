// bun src/cli.ts examples/urgent.ts 'input text' [--save run.json]
// bun src/cli.ts --replay run.json
import {run,type Run,type Program} from './jevascript';
import {fromEnv} from './providers';
import {resolve} from 'node:path';
const args=process.argv.slice(2),file=args[0];
if(!file){console.error('Usage: bun src/cli.ts examples/x.ts [input] [--save run.json]\n       bun src/cli.ts --replay run.json');process.exit(1);}
try {
  let result:Run;
  if(file==='--replay') {
    const saved=await Bun.file(args[1]).json() as Run;
    const program=(await import(resolve(saved.program))).default as Program;
    result=await run(program,{provider:fromEnv({}),input:saved.input,replay:saved.tape,name:saved.program});
  } else {
    const program=(await import(resolve(file))).default as Program;
    result=await run(program,{provider:fromEnv(),input:args[1]?.startsWith('--')?'':args[1]||'',name:file,onEvent:e=>{if(e.kind==='judge')console.error(`[judge] ${e.text}`);}});
    const save=args.indexOf('--save');if(save!==-1){if(!args[save+1])throw new Error('Missing recording file path.');await Bun.write(args[save+1],JSON.stringify(result,null,2));}
  }
  for(const line of result.output)console.log(line);
}catch(error){console.error(error instanceof Error?error.message:error);process.exitCode=1;}
