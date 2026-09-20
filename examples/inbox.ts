import type {Jevascript} from '../src/jevascript';
// The inbox department: triage, draft, edit, package.
export default async function inbox(p:Jevascript, email:string) {
  let reply='';
  // Decide what deserves attention first.
  await p.feels(email,'needs a reply urgently',{confidence:.8}).when({
    yes:()=>p.print('Priority: reply soon. The inbox has developed opinions.'),
    maybe:()=>p.print('Priority: unclear. Check the deadline yourself.'),
    no:()=>p.print('Priority: normal. Finish your coffee.'),
  });
  // Same input, different jobs for the LLM. (match returns a value here; the DSL cannot do that.)
  reply=await p.match(email,{
    'an invitation to speak or participate in an event':()=>p.llm('Draft a brief reply expressing interest, without accepting. Ask for missing event details. Do not invent availability, a talk title or a signature.',email),
    'a routine request to schedule a meeting':()=>p.llm('Draft a short scheduling reply. Ask for two possible times if none were offered; otherwise acknowledge the options and say availability needs checking. Do not pick a time or invent availability. No signature.',email),
    'an unsolicited sales pitch':()=>p.llm('Politely decline in one sentence. No invented excuses, no promises to reconnect, no signature.',email),
    'another kind of message':()=>p.llm('Draft a warm acknowledgement and a useful clarifying question. Do not invent answers, commitments or a signature. Keep it short.',email),
  });
  // Revise until the draft sounds like a person.
  for await (const _ of p.whileFeels(()=>reply,'stiff, corporate, or unnecessarily wordy'))
    reply=await p.llm('Make this brief and natural. Preserve its meaning and questions. Add no new facts or commitments.',reply);
  // A last check can admit uncertainty.
  await p.feels(reply,'polite and clear about the next step',{confidence:.8}).when({
    yes:()=>p.print('Review: ready for you to read.'),
    maybe:()=>p.print('Review: the editor is unsure. Give this a closer look.'),
    no:async()=>{
      reply=await p.llm('Make this polite and give it one clear next step. Preserve facts; make no commitments.',reply);
      p.print('Review: revised once more. Check the final wording.');
    },
  });
  // Generate a subject from the finished reply, not the first draft.
  const subject=await p.llm('Write a reply subject line, at most 7 words. No quotes, labels or commentary.',reply);
  p.print('Subject:');p.print(subject);p.print('Draft reply:');p.print(reply);
}
