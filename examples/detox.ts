import type {Jevascript} from '../src/jevascript';
export default async function detox(p:Jevascript, input:string) {
  let draft=input;
  while((await p.feels(draft,'like a LinkedIn influencer post')).yes)
    draft=await p.llm('Rewrite this as a normal person. Remove corporate language, humblebrags and life lessons. One short sentence.',draft);
  p.print('We have achieved human speech. Probably.');
  p.print(draft);
}
