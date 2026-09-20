import type {Jevascript} from '../src/jevascript';
export default async function urgent(p:Jevascript, message:string, print:(s:string)=>void) {
  await p.feels(message,'genuinely urgent',{confidence:.8}).when({
    yes:()=>print('Okay. This is a drop-everything situation.'),
    maybe:()=>print('Define urgent. And define tiny favor.'),
    no:()=>print('This could have been an email. Oh, it is.'),
  });
}
