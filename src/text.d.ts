// Bun imports text files as strings (`with {type:'text'}`), and `bun build --compile` embeds them.
declare module '*.md' {
  const text: string;
  export default text;
}
