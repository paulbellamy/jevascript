import type {Jevascript} from '../src/jevascript';
// Turn a corporate announcement into human speech.
export default async function translator(p:Jevascript, input:string) {
  let draft=input;
  // Jev picks the description that fits best.
  await p.match(draft,{
    'a corporate announcement':()=>p.print('An exciting development in saying things.'),
    'a sales pitch':()=>p.print('Someone would like our money.'),
    'a normal human message':()=>p.print('A promising start.'),
  });
  // Rewrite, then ask Jev again. Stop when the jargon is gone.
  for await (const _ of p.whileFeels(()=>draft,'full of corporate jargon'))
    draft=await p.llm('Rewrite plainly in one short sentence.',draft);
  // Uncertainty gets its own branch.
  await p.feels(draft,'clear and specific',{confidence:.8}).when({
    yes:()=>p.print('Approved for human consumption.'),
    maybe:()=>p.print('Understandable? Probably. Ask a human.'),
    no:()=>p.print('We have successfully produced different nonsense.'),
  });
  p.print(draft);
}
