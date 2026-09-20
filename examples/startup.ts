import type {Jevascript} from '../src/jevascript';
export default async function startup(p:Jevascript, input:string) {
  const pitch=await p.llm('Pitch this startup in two enthusiastic sentences.',input);
  p.print(pitch);
  await p.chaos(()=>p.feels(pitch,'a financially responsible business idea').when({
    yes:()=>p.print('We are raising a seed round.'),
    no:()=>p.print('We are raising a seed round anyway.'),
  }));
}
