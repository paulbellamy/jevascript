import type {Jevascript} from '../src/jevascript';
export default async function urgent(p:Jevascript, message:string) {
  await p.feels(message,'genuinely urgent',{confidence:.8}).when({
    yes:()=>p.print('Okay. This is a drop-everything situation.'),
    maybe:()=>p.print('Define urgent. And define tiny favor.'),
    no:()=>p.print('This could have been an email. Oh, it is.'),
  });
}
