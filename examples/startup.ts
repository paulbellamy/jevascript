import type {Jevascript} from '../src/jevascript';
export default async function startup(p:Jevascript, input:string, print:(s:string)=>void) {
  const pitch=await p.llm('Pitch this startup in two enthusiastic sentences.',input);
  print(pitch);
  await p.chaos(()=>p.feels(pitch,'a financially responsible business idea').when({
    yes:()=>print('We are raising a seed round.'),
    no:()=>print('We are raising a seed round anyway.'),
  }));
}
