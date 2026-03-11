ENGINE INVARIANTS



1\. nodeId is the permanent identity of a node.

2\. chromeId is a transient runtime binding.

3\. All state mutations must go through stateManager.apply().

4\. chromeSync translates Chrome events into engine mutations.

5\. The UI must never mutate engine state directly.

6\. persistence.js is the only module allowed to write to chrome.storage.

7\. chromeMap enforces a one-to-one mapping between chromeId and nodeId.

