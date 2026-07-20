declare global {
  namespace App {
    interface PageState {
      /** Frame shown by the shallow-routed `?frame=` history entry. */
      frame?: string;
    }
  }
}
export {};
