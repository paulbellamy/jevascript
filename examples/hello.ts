import type {Jevascript} from '../src/jevascript';
// This one runs without any model calls.
export default async function hello(p:Jevascript) {
  const greeting='Hello, uncertainty.';
  p.print(greeting);
  await p.repeat(3,()=>p.print('Everything is going according to some plan.'));
}
