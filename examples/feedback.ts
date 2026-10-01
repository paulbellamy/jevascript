import type { Jevascript } from '../src/jevascript';
export default async function feedback(p: Jevascript, feedback: string, print: (s: string) => void) {
  await p.match(feedback, {
    'a useful suggestion': () => print('Added to the roadmap. A mythical place.'),
    'a bug report': () => print('That is, regrettably, our department.'),
    'someone having a day': () => print('We hear you. We are also having a day.'),
  });
}
