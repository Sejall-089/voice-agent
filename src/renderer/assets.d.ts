// A sound file imported from the renderer is a URL to the bundled asset (Vite). One today:
// the needs-you chime (M23).
declare module "*.wav" {
  const url: string;
  export default url;
}
