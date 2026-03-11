DATA MODELS



TreeNode



Fields:

\- id: permanent nodeId

\- kind: branch | tab | group | memo

\- state: live | kept

\- chromeId: Chrome runtime id

\- title

\- url

\- children\[]



Indexes



nodeMap

nodeId → node



chromeMap

(kind:chromeId) → nodeId



parentMap

nodeId → parentId

