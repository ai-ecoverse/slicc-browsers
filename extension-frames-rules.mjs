export const whenShownInput = [
  'Input.dispatchKeyEvent',
  'Input.dispatchMouseEvent',
  'Input.dispatchTouchEvent',
  'Input.dispatchDragEvent',
  'Input.emulateTouchFromMouseEvent',
  'Input.insertText',
  'Input.imeSetComposition',
  'Input.synthesizePinchGesture',
  'Input.synthesizeScrollGesture',
  'Input.synthesizeTapGesture',
];

export const shownRefusal =
  "slicc: refused: a browser extension's frame (chrome-extension://) is showing or focused in this tab, such as a password manager's autofill list; close it or reload the tab";

export const presentRefusal =
  "slicc: refused: this tab holds a browser extension's frame (chrome-extension://), such as a password manager's autofill list, so it can't be captured whole or streamed; reload the tab to remove it; an active screencast is stopped or its frames are dropped until the frame is gone";
