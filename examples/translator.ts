import type {Jevascript} from '../src/jevascript';
// Turn a corporate announcement into human speech.
export default async function translator(p:Jevascript, input:string, print:(s:string)=>void) {
  let draft=input;
  // Jev picks the description that fits best.
  await p.match(draft,{
    'a corporate announcement':()=>print('An exciting development in saying things.'),
    'a sales pitch':()=>print('Someone would like our money.'),
    'a normal human message':()=>print('A promising start.'),
  });
  // Rewrite, then ask Jev again. Stop when the jargon is gone.
  while((await p.feels(draft,'full of corporate jargon')).yes)
    draft=await p.llm('Rewrite plainly in one short sentence.',draft);
  // Uncertainty gets its own branch.
  await p.feels(draft,'clear and specific',{confidence:.8}).when({
    yes:()=>print('Approved for human consumption.'),
    maybe:()=>print('Understandable? Probably. Ask a human.'),
    no:()=>print('We have successfully produced different nonsense.'),
  });
  print(draft);
}
