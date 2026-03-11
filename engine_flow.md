ENGINE FLOW



Chrome Event

&nbsp;   ↓

chromeSync listener

&nbsp;   ↓

translate event → action

&nbsp;   ↓

stateManager.apply()

&nbsp;   ↓

mutation result

&nbsp;   ↓

sideEffects returned

&nbsp;   ↓

chromeSync.executeSideEffects()

&nbsp;   ↓

Chrome API calls

