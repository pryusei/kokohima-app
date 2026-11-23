export interface Change {
  /** git の状態の1文字（A・M・D・R・C など） */
  status: string;
  /** 判定に使うパス（名前の変更と複写では移動先） */
  path: string;
  /** 行にあったすべてのパス（名前の変更と複写では移動元と移動先） */
  paths: string[];
}
export interface Classification {
  docsOnly: boolean;
  needsUnitTest: boolean;
  hasUnitTest: boolean;
}
export declare function parseNameStatus(text: string): Change[];
export declare const isDoc: (path: string) => boolean;
export declare const isUnitTest: (path: string) => boolean;
export declare const isCode: (path: string) => boolean;
export declare function classify(changes: Change[]): Classification;
