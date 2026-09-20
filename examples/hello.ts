import type {Jevascript} from '../src/jevascript';
// This one runs without any model calls.
export default async function hello(_p:Jevascript, _input:string, print:(s:string)=>void) {
  const greeting='Hello, uncertainty.';
  print(greeting);
  for(let i=0;i<3;i++)print('Everything is going according to some plan.');
}
