import type {Jevascript} from '../src/jevascript';
export default async function feedback(p:Jevascript, feedback:string) {
  await p.match(feedback,{
    'a useful suggestion':()=>p.print('Added to the roadmap. A mythical place.'),
    'a bug report':()=>p.print('That is, regrettably, our department.'),
    'someone having a day':()=>p.print('We hear you. We are also having a day.'),
  });
}
