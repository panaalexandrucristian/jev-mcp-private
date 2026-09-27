# Jev Flow — extensie privată pentru Claude Code și OpenCode

## 1. Obiectiv și statut

**Propunere de proiectare, nu implementare existentă.** Extindem pluginul privat `jev` cu skill-ul **`jev-flow`**, comenzile **`jev-locate` / `jev-done`**, subagentul **`jev-locator`**, un helper local și hook-uri. Folosim cele **11 unelte MCP existente**; nu este necesară o unealtă MCP Jev nouă.

Ținte: **Claude Code 2.1.283 și OpenCode 2.0.12 pe macOS**; Linux best-effort. Conținutul distribuit în plugin va fi în engleză. Documentul de față este în română.

### De ce acest flow

În agregatul furnizat de utilizator, explorarea produce **10,3 MB / 57%** din bytes returnați în context, există **110 recitiri din 499 Read**, iar înaintea primei editări sunt median 8 apeluri de explorare, p90 23. În schimb, `jev_decide` reprezintă 70/102 apeluri Jev, iar `find` + `rerank` numai 4.

Flow-ul urmărește să reducă **materialul de explorare ajuns la agentul principal**, apoi deliberarea repetată și verificarea informală a finalizării. Economia totală de tokeni sau timp rămâne de demonstrat: un subagent mută munca într-un alt context și adaugă propriul consum.

### Ce există deja

- `skills/jev/` conține convențiile upstream și rămâne intact: `PRIVATE.md:10`; `skills/jev/SKILL.md:19–46`.
- Claude înregistrează MCP-ul prin `.claude-plugin/plugin.json:12–16`.
- OpenCode înregistrează MCP-ul și skill-ul prin `opencode-plugin.js:29–65`, păstrând intrările existente.
- Ambele pornesc pachetul public `@latest`; checkout-ul nu dovedește versiunea serverului pornit (`PRIVATE.md:3`).

**Toate bugetele, fișierele și regulile de orchestrare introduse mai jos sunt propuneri**, în limitele alegerilor delegate de utilizator.

## 2. Activare și contractul general

Descriere propusă pentru skill:

> Adaptive coding workflow for repository tasks: delegate broad code discovery to jev-locator, use bounded Jev judgments only when they change the next action, run real checks after code changes, and verify completion with jev_gate. Use for debugging, implementation, refactoring, and finalizing code changes.

Skill-ul devine eligibil pentru selecție automată după descriere. Selecția de către model nu este garantată; hook-urile adaugă indicii scurte, iar comenzile oferă acces explicit.

Ordinea logică este:

**triaj → localizare → ipoteze → decizie → implementare → verificări reale → review opțional → gate → raport final**.

Nu este o obligație de a apela fiecare unealtă. Fișiere cunoscute și schimbare clară: se sar localizarea semantică și decizia. După orice modificare de cod se parcurg verificările reale și gate-ul final, cu excepțiile explicite pentru indisponibilitate sau interdicția de transmitere a datelor.

### Bugete inițiale propuse

| Element | Buget / regulă |
|---|---|
| Localizare | Un subagent activ pe întrebare; fără explorare paralelă duplicată în firul principal. |
| Candidați | Cel mult 48 fragmente/apel, fiecare cel mult 1.000 caractere, incluzând identificarea sursei. |
| Rezultate aduse părintelui | Cel mult 5 localizări și 4.000 caractere, cu cale, hash, interval și motiv scurt. |
| Extinderea căutării | Cel mult două loturi semantic diferite per întrebare; al doilea numai cu domeniu/dovezi noi. |
| Hint de explorare | După 4 apeluri de explorare în aceeași cerere sau a doua recitire a aceluiași interval cu același hash. Un singur hint per cerere. |
| Decizie | Un apel pe același set de alternative, dovezi și priorități. |
| Gate | Un apel pe snapshot final; rechemare numai după schimbarea patchului, dovezilor sau afirmațiilor, în afara retry-ului operațional autorizat. |
| Hook-uri | Numai logică locală scurtă; fără teste, apeluri LLM sau scanări integrale ale repo-ului în fiecare hook. |

Pragurile MCP rămân cele existente. Suplimentar, pentru `jev_decide`, o decizie cu consecințe cere verificare umană dacă `confidence` lipsește sau este sub **0,8**, dacă există escape hatch sau avertismente relevante. Acesta este un prag de flow propus, nu o garanție de corectitudine.

## 3. Pașii flow-ului

În formele de input de mai jos, valorile dintre `<...>` sunt **substituenți de documentație**. Agentul le înlocuiește cu cererea, fragmentele și rezultatele reale; nu transmite substituenții și nu fabrică loguri.

| Pas | Declanșare / când se sare | Input concret și unealta | Output folosit și următoarea acțiune | Munca înlocuită |
|---|---|---|---|---|
| **0. Triaj local** | La o cerere nouă. Fără apel Jev dacă natura sarcinii și fișierele sunt clare. `classify` numai pentru o clasificare semantică ambiguă sau un lot real. | `jev_classify`: `{"items":[{"id":"task","text":"<cerere>"}],"classes":[{"id":"inspect","description":"Read-only investigation; no implementation requested."},{"id":"change_known","description":"Code change with concrete affected files already identified."},{"id":"discover_then_change","description":"Code change requiring discovery of implementation locations."}],"purpose":"Choose the investigation route"}` | `classification`, `decision`, `margin`. `review` → triaj manual. Cererea utilizatorului are prioritate față de clasificare. | Clasificare verbală repetată și planuri lungi pentru sarcini evidente. |
| **1. Localizare izolată** | Fișiere necunoscute sau mai multe rezultate semantic ambigue. Se sare pentru o cale/simbol exact deja identificat. | Părintele delegă către `jev-locator`. Copilul rulează helperul, apoi `jev_find`: `{"query":"<comportamentul căutat>","candidates":[{"id":"c0","text":"<cale:interval + fragment>"}],"top_k":5}`. Folosește `jev_rerank` cu aceeași formă când contează ordinea mai multor rezultate. | `find.exists_verdict` și `top`, respectiv `rerank.ranked`. Copilul verifică sursele selectate și întoarce localizări compacte. `absent` privește numai candidații trimiși, nu întregul repo. | Deschiderea în firul principal a multor fișiere și citirea tuturor rezultatelor brute. |
| **2. Ipoteze și dovezi** | După identificarea punctelor relevante, când există afirmații verificabile despre cauză. Se sare dacă reproducerea și cauza sunt deja clare. | `jev_verify`: `{"claims":["<ipoteză concretă>"],"evidence":[{"id":"code","text":"<fragment real>"},{"id":"repro","text":"<rezultat real al reproducerii>"}]}`. `jev_noul`: `{"propositions":["<ipoteză de prioritizat>"],"context":"<observații>"}` numai dacă se cere probabilitate, nu demonstrație. | `verified/contradicted/unsupported`; `unsupported` cere dovezi noi. Noul poate ordona ce investigăm, nu decide omiterea testelor. | Dezbaterea repetată a unei ipoteze fără separarea dovezii de presupunere. |
| **3. Decizie limitată** | Există 2–6 mecanisme plauzibile și priorități explicite care schimbă alegerea. Se sare pentru modificări mecanice sau o singură soluție evidentă. | `jev_decide`: `{"decision":"<alegerea>","evidence":"<fapte/măsurători>","priorities":"<priorități ale utilizatorului>","candidates":[{"id":"a","description":"<mecanism A>"},{"id":"b","description":"<mecanism B>"}],"requirements":["<o proprietate verificabilă>"],"escape_hatches":true}` | `selected`, `escaped`, `confidence`, `checks`, `warnings`. `investigate` → colectăm dovezi; `ask_user` → întrebăm; `none` → reformulăm alternativele fără a pretinde o alegere acceptată. | Compararea repetată a acelorași alternative, fără criterii stabile. |
| **4. Implementare** | După localizare/decizie; modificare directă prin uneltele native. | **Niciun apel Jev obligatoriu în timpul editării.** Agentul citește intervalele relevante și editează. | Patch real; fingerprintul verificărilor și gate-ului anterior devine invalid când codul se schimbă. | Nu înlocuim editarea, compilatorul sau raționamentul necesar implementării. |
| **5. Verificări reale** | Obligatoriu după modificări de cod, pe snapshotul final. | Comenzile de test/build/typecheck/lint existente în repo. Dacă rezultatele susțin afirmații ambigue: `jev_verify` cu logurile reale în `evidence`. | Exit code, teste efectiv rulate, erori, rezultat verificabil. Testele eșuate nu sunt transformate în succes prin Jev. | Recitirea repetată a logurilor și afirmațiile informale «pare că trece». Nu înlocuiește rularea verificărilor. |
| **6. Review intermediar, opțional** | Patch riscant sau nevoie de feedback înainte de verificarea finală. Se sare când gate-ul final urmează imediat pe același patch și aceleași dovezi. | `jev_review`: `{"request":"<cererea>","diff":"<diff real>","tests":"<rezultate reale disponibile>"}` | `action`, `reason_codes`, `limiting_rubrics`, `safe_to_apply`, `composite`. Rezolvăm problemele, apoi rerulăm verificările afectate. | Review informal repetat; evităm dublarea review + gate pe input identic. |
| **7. Gate final** | Obligatoriu după schimbări de cod; lansat și prin `jev-done`. | `jev_gate`: `{"request":"<cererea>","diff":"<diff final>","tests":"<output real>","claims":["<criteriu de acceptare îndeplinit>","<comanda concretă de verificare a trecut>"],"evidence":[{"id":"test-log","text":"<output real, identificat>"},{"id":"patch","text":"<fragment de patch care susține criteriul>"}]}` | `action`, `review`, `verification.results`, `reason_codes`. Auto permite raportarea rezultatului în limitele dovezilor; contradicția/escaladarea urmează politica de la §5. | Declarația «gata» bazată pe impresie sau pe faptul că agentul a scris un patch. |
| **8. Raport final** | După gate sau fallback explicit. | Fără alt apel Jev. | Schimbarea, verificările efective, rezultatul gate-ului, limitele și problemele rămase. | Reformulări repetitive și recapitulări care introduc afirmații noi neverificate. |

**Baza contractelor:** `src/index.ts:150–250` verify; `348–439` noul; `457–510` find; `530–655` classify; `677–795` decide; `813–905` rerank; `1464–1525` review; `1541–1699` gate. Regulile de utilizare existente: `skills/jev/SKILL.md:24–45`.

### Ramuri auxiliare, numai când sunt necesare

| Situație | Input | Rezultat și limită |
|---|---|---|
| Text extern potențial nerelevant sau cu instrucțiuni injectate | `jev_screen({"text":"<text extern>","purpose":"<informația căutată>"})` | `pass/review/block/skip`; agentul aplică politica existentă. Dacă textul a intrat deja în context, screening-ul nu recuperează bytes. Preferăm ca ingestia largă să rămână în copil. |
| Documentație versus implementare, rezumat versus sursă | `jev_compare({"passage_a":"<A>","passage_b":"<B>","aspects":["<proprietate>"]})` | Relații independente pe aspecte; acordul nu dovedește adevărul. |
| Mai multe potriviri sintactice, dar un singur sens corect | `jev_extract({"document":"<document>","fields":[{"id":"version","pattern":"[0-9]+\\.[0-9]+\\.[0-9]+","description":"The current supported release version"}]})` | Valoare verbatim și status. Pentru o singură regulă deterministă suficientă, folosim direct parser/regex. |

Surse: `src/index.ts:267–331,923–999,1077–1237`; `skills/jev/SKILL.md:21,28–29,35,42–43`.

## 4. Localizatorul: mecanismul economiei de context

### Helper propus: `scripts/jev-candidates.mjs`

Node stdlib, fără dependențe npm noi și fără apeluri proprii la provider. Interfață propusă:

```sh
node "<plugin-root>/scripts/jev-candidates.mjs" \
  --root "<repo-root>" --query "<query>" \
  --limit 48 --chunk-chars 1000
```

Contract:

1. Descoperă fișierele urmărite și neignorate relevante, inclusiv fișiere noi neignorate. Folosește Git prin `execFile` cu argumente separate; nu evaluează query-ul ca shell.
2. Respectă `.gitignore`, denylist-ul flow-ului și excluderile de conținut sensibil; nu traversează symlinkuri în afara repo-ului.
3. Produce căi/outline și ferestre de cel mult 60 de linii, plafonate la bugetul de caractere. Outline-ul este lexical, nu pretinde analiză AST completă.
4. Pentru fișiere mari sau rezultate peste buget, returnează metadate de acoperire incompletă. Nu prezintă primii 48 de candidați ca inventar exhaustiv.
5. Emite în stdout un obiect cu `candidates` și o hartă separată `id → path, sha256, start_line, end_line`. Nu persistă fragmentele. Spre Jev se transmit numai câmpurile acceptate de schema uneltei.
6. Folosește ID-uri opace sigure, de exemplu `c0`, păstrând căile în hartă; astfel normalizarea ID-urilor din `jev_find` nu corupe maparea către fișiere (`src/lib.ts:23–53`).

### Subagent propus: `jev-locator`

Primește numai întrebarea, repo-ul, prioritățile relevante și eventual localizări cunoscute. Nu primește întregul istoric al părintelui. Rulează helperul și, dacă alegerea chiar este semantică, `find` sau `rerank`.

Este read-only pentru repo: nu editează, nu rulează teste care modifică proiectul, nu lansează alți subagenți. Accesul shell se limitează la helper și comenzile de citire necesare; permisiunile se verifică în smoke test, fără a prezenta instrucțiunea «read-only» drept sandbox de securitate.

Raportul către părinte:

```json
{
  "coverage_complete": false,
  "hits": [
    {
      "path": "src/example.ts",
      "sha256": "<hash calculat>",
      "lines": [20, 48],
      "reason": "<motiv scurt verificat prin citire>"
    }
  ],
  "next_read": "<intervalul care merită citit>",
  "unresolved": "<ce nu a putut fi stabilit>"
}
```

Acesta este un exemplu de contract, nu o constatare despre un fișier existent. Părintele citește intervalele indicate înainte să editeze și verifică hash-ul. Dacă s-a schimbat, localizarea se invalidează.

**Limita esențială:** helperul produce text în contextul copilului, iar copilul îl transmite Jev. Propunerea nu pretinde eliminarea tokenilor de retransmitere din copil. Elimină expunerea întregii explorări către părinte. Un adaptor care face direct helper → MCP ar fi o extensie ulterioară, nu o capacitate existentă a acestui flow.

## 5. Politica rezultatelor și finalizării

Ordinea de interpretare este importantă:

1. **Afirmație validă contrazisă:** oprire și întrebare către utilizator, cu verdictul și cifrele. Un răspuns invalid în altă parte nu anulează contradicția observată.
2. **Transport sau `invalid_response`:** un singur retry logic, cu același input. Dacă eșuează, verificările reale continuă, iar raportul spune **«Jev indisponibil; gate neevaluat»**. Nu înregistrăm `auto`. Anularea de către utilizator nu este un motiv de retry.
3. **Rezultat semantic `review` / încredere mică la pas de rutină:** inspecție manuală, apoi continuare justificată, fără reluarea identică a apelului pentru un verdict mai plăcut.
4. **Gate final cu `escalate` sau încredere mică; decizie cu consecințe neconcludentă:** oprire și întrebare către utilizator. Un `review` cauzat numai de dovezi lipsă poate fi rezolvat prin dovezi noi și un apel nou; dacă rămâne nerezolvat, nu declarăm finalizarea.
5. **Auto valid:** se aplică numai snapshotului și afirmațiilor evaluate. Nu înlocuiește criteriile explicite ale utilizatorului și testele reale.

`jev_gate` însuși nu escaladează orice contradicție indiferent de confidence (`src/lib.ts:376–384`); flow-ul adoptă intenționat regula mai strictă cerută de utilizator.

Retry-ul de flow este distinct de retry-urile HTTP interne: transporturile locale pot încerca implicit de trei ori (`src/provider.ts:39–49`). Două apeluri logice pot însemna mai multe cereri HTTP; se raportează separat când informația este disponibilă. Nu modificăm pe ascuns configurația unui server `jev` preexistent.

### Legarea verificărilor de snapshot

Metadatele leagă rezultatele de:

- repo/worktree și sesiune;
- hash-urile fișierelor relevante și manifestul snapshotului;
- hash-ul diff-ului final, incluzând modificări staged, unstaged și fișiere noi relevante;
- hash-urile cererii, afirmațiilor și dovezilor;
- identificatorii apelurilor de test/gate și timpii lor.

La începutul sarcinii se identifică modificările preexistente, fără a le revendica drept munca agentului. Un test se consideră relevant numai dacă snapshotul nu s-a schimbat în timpul sau după rulare. După schimbări noi, rezultatele afectate și gate-ul se invalidează. Mtime singur nu este suficient.

Pentru patchuri peste limitele MCP, nu folosim trunchierea drept aprobare: împărțim review-ul în părți și păstrăm explicit limitele verificării globale. Un gate făcut doar pe un rezumat al unui patch mare nu devine dovadă că întregul patch a fost evaluat.

## 6. Date, denylist și stare locală

### Propunere: `.jev-flow-denylist`

Fișier opțional la rădăcina repo-ului, cu pattern-uri de căi și comentarii. O linie `*` dezactivează transmiterea datelor acelui repo către Jev. Opt-out-ul are prioritate față de obligația de a încerca gate-ul: se execută verificările locale, iar raportul spune **«Jev dezactivat pentru acest repo; gate neevaluat»**. Nu schimbăm providerul și nu cerem exceptarea politicii doar pentru a obține un gate.

Se exclud întotdeauna `.env` și variantele sale, cheile private și fișierele de credențiale identificate. Helperul oferă și un mod de sanitizare pe stdin pentru diff-uri și loguri; nu citește `.env` pentru a construi lista de valori secrete. Se elimină credențialele recognoscibile din conținut; dacă un fragment rămâne suspect sau nu poate fi curățat fără a denatura dovada, se omite și se raportează lipsa dovezii. Nu pretindem că un regex poate identifica orice secret arbitrar.

Skill-ul impune această pregătire înaintea tuturor apelurilor flow-ului, nu numai la localizare. Hook-urile pot valida aplicarea ei acolo unde API-ul permite, însă acest plugin nu este prezentat ca un firewall pentru toate uneltele și toate apelurile externe ale CLI-ului.

### Stare nouă permisă

`~/.cache/jev-flow/<repo-hash>/<session-hash>/` conține numai căi, hash-uri SHA-256, intervale, contoare și timpi. Rezultatele semantice și textele există numai în memoria procesului/contextul activ; persistăm doar metadatele necesare corelării și contoare de rezultat.

- Retenție: 30 de zile, curățare la pornire, fără traversarea symlinkurilor.
- Invalidare: hash de conținut, modificări de catalog/denylist și snapshot nou.
- La restart, metadatele nu se transformă singure în dovadă de aprobare; rezultatul este revalidat din transcriptul existent sau gate-ul rămâne necunoscut.
- Nu scriem copii de cod, diffuri, prompturi sau loguri în cache-ul flow-ului.

CLI-urile continuă să aibă propriile transcrieri native, care pot conține rezultatele uneltelor. Regula metadata-only privește starea nouă adăugată de extensie; nu promitem că dispar transcrierile native.

## 7. Livrarea peste pluginul privat

### Fișiere propuse

| Fișier | Rol |
|---|---|
| `skills/jev-flow/SKILL.md` | Activare după descriere, reguli adaptive și trimiteri la referințe. |
| `skills/jev-flow/reference/workflow.md` | Contractele pașilor, politici de fallback și exemple JSON, în engleză. |
| `commands/jev-locate.md` | Delegă către localizator cu bugetele de mai sus. |
| `commands/jev-done.md` | Verificări reale, colectarea dovezilor, gate și raport final. |
| `agents/jev-locator.md` | Promptul read-only și frontmatter-ul Claude; corpul este reutilizat de adaptorul OpenCode. |
| `hooks/hooks.json` | Evenimentele Claude și invocarea handlerului local. |
| `scripts/jev-candidates.mjs` | Construirea candidaților și sanitizarea textului; Node stdlib. |
| `scripts/jev-flow-hook.mjs` | Adaptor Claude pentru evenimente și hints. |
| `private/jev-flow/state.mjs` | Hash-uri, invalidare, contoare și retenție; logică comună. |
| `private/jev-flow/opencode.mjs` | Înregistrare V2 a skill-ului, agentului, comenzilor și hook-urilor. |
| `scripts/jev-flow-metrics.py` | Agregare A/B read-only, Python stdlib. |
| `private/jev-flow/ab/tasks.json` | Manifestul corpusului și criteriile înghețate ale experimentului. |
| `private/jev-flow/test/` | Teste ale helperului, politicii, adaptorilor și contractelor de payload. |

Modificări numai în fișiere private existente: `opencode-plugin.js` apelează `setupFlow(ctx)` din modulul nou; `PRIVATE.md` documentează utilizarea, opt-out-ul și verificările. Manifestul Claude poate folosi directoarele standard descoperite automat; orice extindere necesară rămâne în `.claude-plugin/plugin.json`.

Nu modificăm `src/`, `skills/jev/`, `README.md`, `package.json` sau alte fișiere upstream. Nu adăugăm dependențe în manifestul npm upstream. Node 22 există deja în cerințele pachetului (`package.json:23–24`).

### Claude Code 2.1.283

- Directoarele standard distribuie skill-ul, comenzile, agentul și `hooks/hooks.json` odată cu pluginul.
- Pluginul se numește `jev`; comenzile reale sunt **`/jev:jev-locate`** și **`/jev:jev-done`**. Identitățile logice rămân cele acceptate de utilizator.
- Scripturile se referă la `${CLAUDE_PLUGIN_ROOT}` în conținutul pluginului și în configurația hook-urilor. Nu presupun că variabila există automat în orice shell lansat de agent.
- `SessionStart` inițializează metadatele; `PostToolUse` numără explorarea, invalidează snapshoturile și sugerează localizarea sau gate-ul după rezultatele relevante. Hook-urile disting firul principal de copil, pentru a nu genera bucle de delegare.
- **Implicit:** mesaje scurte de context la evenimentele potrivite; hook-ul `Stop` poate afișa o atenționare utilizatorului, fără `decision:block` și fără a forța continuarea.
- **Opt-in propus:** `JEV_FLOW_STRICT=1`. `Stop` poate bloca o finalizare fără dovadă proaspătă și direcționează către `jev-done`. Respectă `stop_hook_active`; nu blochează întrebările către utilizator și raportarea explicită «incomplet/indisponibil/dezactivat». Limita propusă este o singură redirecționare automată pentru același snapshot, apoi raport clar, nu buclă infinită și nu aprobare falsă.

Distincție importantă: `Stop.additionalContext` poate continua conversația chiar fără un mesaj de eroare; de aceea nu îl folosim drept presupus hint complet neblocant. Hint-ul către agent se emite înainte de oprire, de exemplu după test sau editare; la Stop rămâne notificarea neblocantă către utilizator.

Referințe oficiale consultate: [manifest și namespace](https://code.claude.com/docs/en/plugins-reference), [hook-uri și controlul Stop](https://code.claude.com/docs/en/hooks#stop). Încărcarea efectivă și permisiunile se validează pe 2.1.283 înainte de distribuire.

### OpenCode 2.0.12

Se păstrează forma existentă `export default { id, setup(ctx) }`, încărcată din directorul clonat (`opencode-plugin.js:29–65`; `PRIVATE.md:45–72`). Modulul privat nou folosește:

- `ctx.skill.transform` pentru `jev-flow`, cu aceeași regulă de păstrare a intrărilor existente;
- `ctx.agent.transform` și `editor.update("jev-locator", ...)`, care creează agentul când lipsește; setează `mode: "subagent"`, promptul și permisiunile;
- `ctx.command.transform` și `editor.add` pentru **`/jev-locate`** și **`/jev-done`**; invocarea trimite instrucțiunile în sesiunea corectă, păstrând `delivery`;
- `ctx.tool.hook("execute.before", ...)` / `ctx.tool.hook("execute.after", ...)` pentru contoare, verificarea payloadurilor și invalidare;
- `ctx.session.hook("context", ...)` pentru un hint scurt în următoarea cerere către model, fără a rescrie istoricul utilizatorului.

Aceste nume și structuri au fost verificate în pachetul **`@opencode/plugin@2.0.12`** și în [sursele V2 etichetate](https://github.com/anomalyco/opencode/tree/v2.0.12/packages/plugin/src/promise). Crearea prin `AgentEditor.update` este vizibilă în [agent.ts:74–84](https://github.com/anomalyco/opencode/blob/v2.0.12/packages/core/src/agent.ts#L74-L84).

Pachetul local `@opencode-ai/plugin` găsit în config este **1.16.2**; hook-urile sale V1 nu se copiază în extensia V2. [Ghidul de migrare](https://opencode.ai/v2/docs/migrate-v1) precizează că implementările pluginurilor V1 nu rulează în V2.

**Degradare concretă:** verificăm existența metodelor, înregistrarea și primirea evenimentelor prin smoke test. O capabilitate absentă dezactivează numai funcția aferentă și produce un diagnostic unic; skill-ul/comenzile disponibile continuă. Coliziunile cu nume existente nu suprascriu munca utilizatorului și sunt raportate.

**Limită a modului strict:** API-ul inspectat nu oferă un echivalent direct Claude `Stop` pentru blocarea oricărui mesaj final. În OpenCode, controlul strict se aplică la frontiera explicită `jev-done`, cu verificarea dovezii înainte de emiterea finalizării prin comandă. Mesajele libere ale agentului rămân guvernate de skill și hints. Nu declarăm o blocare globală a finalizării pe 2.0.12; dacă se cere această garanție, capabilitatea este raportată ca nesuportată, nu simulată printr-un hook inventat.

Actualizarea ajunge prin mecanismele existente: update al pluginului Claude; pull și restart pentru OpenCode (`PRIVATE.md:37–43,61–68`).

## 8. Anti-pattern-uri

1. **Jev pentru orice alegere mecanică.** Un simbol exact, un exit code sau un parser suficient nu necesită evaluare semantică.
2. **Încărcarea întregului repo în contextul principal înainte de rerank.** Asta plătește deja costul urmărit de optimizare.
3. **Rerank fără `top_k` când se doresc numai câteva rezultate.** Implicit întoarce toți candidații, inclusiv textele (`src/index.ts:816,888–904`).
4. **Decide repetat până iese răspunsul preferat.** Reapelare numai după criterii sau dovezi material noi.
5. **Noul drept substitut pentru reproducere, teste sau dovadă.** «Probabil adevărat» nu înseamnă «verificat».
6. **Review și gate consecutiv pe același input fără motiv.** Gate-ul conține deja review-ul.
7. **`auto` interpretat uniform.** La verify poate însemna o contradicție suficient de sigură; la gate nu aprobă automat merge/deploy.
8. **Gate bifat doar pentru că a existat un apel.** Contează rezultatul valid, snapshotul și dovezile furnizate.
9. **Claim despre teste susținut numai prin textul cererii sau prin câmpul `tests`.** În gate, suportul trebuie să fie în `evidence` (`src/index.ts:1620–1629`).
10. **Ascunderea costului subagentului în A/B.** Reducerea contextului principal și economia totală sunt metrici diferite.
11. **Cache după cale/mtime sau reuse după editare.** Hash-ul de conținut și domeniul dovezii sunt obligatorii.
12. **Hook-uri care rulează modelul/testele la fiecare Read ori care nu permit raportarea unui blocaj.** Ele pot transforma optimizarea într-o sursă nouă de latență și bucle.

## 9. Experiment A/B reproductibil

### Brațe și număr de rulări

- **A:** pluginul privat actual și skill-ul upstream `jev`.
- **B:** același plugin și aceeași versiune MCP, plus `jev-flow`.
- **6 sarcini × 3 repetări × 2 brațe = 36 de rulări pentru un CLI.** Repetăm separat în celălalt CLI: 72 pentru comparația completă. Rezultatele nu se amestecă între clienți.
- Agentul principal și localizatorul folosesc același model/efort în experiment, pentru a izola schimbarea de flow. Nu schimbăm simultan arhitectura și modelul copilului.

### Corpus propus: două sarcini în fiecare dintre trei repo-uri existente

| ID | Repo și bază | Sarcină înregistrată | Acceptare fixată înainte de A/B |
|---|---|---|---|
| M1 — bugfix | `jev-mcp`, părintele commitului `8ff16ff` | Repararea normalizării flag-urilor regex, astfel încât `gi` să nu devină `gig`. | Test independent cu două potriviri diferite ca majuscule/minuscule; fără `invalid_pattern`; suitele existente trec. Commitul și testul său au fost inspectate. |
| M2 — refactor | `jev-mcp`, părintele `ac76f19` | Unificarea verificării obiectelor JSON într-un helper comun între unelte și transport. | Obiectele acceptate, null/array/primitivi respinși; contractele publice și testele existente rămân identice. |
| A1 — feature | `jev-agent-tools`, `56b6e6f08fa4d87a1041e596e0a222f15f1fe1fe438` nu se folosește: baza corectă este `56b6e6f08fa4d87a1041e596e0a222f15f1fe438` | Adăugarea unui override de root URL pentru transportul OpenRouter, păstrând endpointul implicit și normalizând slash-ul final. | Mock fetch verifică URL implicit/custom, autentificare neschimbată și aceeași tratare a erorilor. Implementarea actuală are URL fix: `src/transports/openrouter.ts:17–29`. |
| A2 — refactor | `jev-agent-tools`, aceeași bază | Extragerea logicii comune de citire și parsare JSON din transporturile OpenRouter/Cloudflare, păstrând diferențele de envelope. | Comportamentul public, mesajele redactate și cazurile usage/envelope din teste rămân neschimbate. Surse: `src/transports/openrouter.ts:35–59`, `cloudflare.ts:26–56`. |
| H1 — bugfix | `handoff-test-kit`, `6056be4431dfdbe6e74e4d387a56090bfdcdd321` | Acceptarea punctului de final de propoziție în cazul numeric C17, fără a accepta numere diferite sau componente de versiune ca aceeași valoare. | C17 trece semantic; controale negative independente rămân respinse; cazurile anterior gating trec. Baza: `tests/test_verification.py:41–52`, `README.md:114–118`. |
| H2 — feature | `handoff-test-kit`, aceeași bază | Recunoașterea căilor inline-code cu extensia `.txt` în verificarea căilor. | Fișier existent → succes; absent → eșec; nume cu spații/Unicode; expresiile shell și căile propuse păstrează regulile existente. Baza: `README.md:81–85,132–134`. |

Sarcinile M1/M2 sunt replay-uri istorice în copii izolate, nu solicitări de modificare a upstream-ului în pluginul real. Commiturile-soluție și testele oracle nu se oferă agentului; i se oferă numai cerința și baza. Manifestul experimentului trebuie să rețină SHA-ul corect al fiecărei baze, promptul fix și criteriile fixe; nu începem rulările dacă baseline-ul sau un oracle nu este pregătit.

### Controlul experimentului

- Snapshot identic pentru fiecare pereche, sesiune nouă, fără istoric sau rezultate ale celuilalt braț.
- Ordine A/B și B/A alternată/randomizată cu seed înregistrat; fără simultaneitate care introduce concurență artificială la teste.
- Aceleași versiuni CLI, model, effort, provider Jev și versiune MCP efectivă, consemnate. Nu lăsăm `@latest` să schimbe serverul între brațe; folosim aceeași versiune rezolvată în configurația experimentului.
- Aceeași stare a dependențelor și build-cache-ului; nu pretindem control absolut asupra cache-ului providerului. Îi raportăm separat utilizarea.
- Testele oracle au aceeași listă și același numitor pentru A și B. Ștergerea unui test sau nerularea lui nu poate îmbunătăți rata de succes.
- Fiecare rulare pornește într-o copie de lucru separată; nu resetăm checkout-urile curente ale utilizatorului.

### Metrici și agregare

Script propus: `scripts/jev-flow-metrics.py`, numai stdlib, citire read-only.

**Surse:** Claude `~/.claude/projects/*/*.jsonl`, cu identificarea separată a firelor copil; OpenCode `~/.local/share/opencode/opencode.db`, conexiune SQLite `mode=ro`. Schema `session.parent_id`, `message.session_id/data` și `part.session_id/data` a fost verificată fără citirea mesajelor. Parserul inspectează schema/versionarea și marchează datele absente drept necunoscute, nu zero.

| Metrică | Definiție |
|---|---|
| Bytes explorare — principal | Suma UTF-8 a textului efectiv întors principalului de explorare și a raportului localizatorului; include shell-ul de explorare identificabil. Nu dublează aceeași parte de mesaj. |
| Bytes și tokeni — total | Principal + toți descendenții + apelurile Jev; expune costul mutat în copil. Tokenii modelului principal și tokenii Jev se raportează separat, apoi eventual cost monetar dacă tarifele sunt cunoscute. |
| Recitiri | Citiri ale aceleiași căi, aceluiași hash și interval suprapus în aceeași sesiune; schimbările de hash nu sunt recitiri redundante. |
| Înainte de prima editare | Număr de apeluri și bytes până la prima modificare reală; identifică și editările prin shell/helper. |
| Timp | Wall time până la finalizarea evaluabilă; timpul uneltelor, așteptarea utilizatorului și retry-urile separat. Duratele paralele nu se adună ca și cum ar fi timp calendaristic. |
| Calitate | Proporția rulărilor care trec toate verificările oracle și criteriile de acceptare; afirmații false de succes și blocaje separat. |

Agregarea shell-ului păstrează o categorie `unknown` pentru comenzile neclasificabile; simpla prezență a lui `cd` nu transformă explorarea în `shell_other`. Pentru rezultatele externalizate de harness într-un fișier, bytes de context înseamnă preview-ul efectiv livrat, nu automat întregul fișier.

**Criteriul de adopție stabilit de utilizator:** reducere de cel puțin **30% a bytes de explorare în firul principal**, fără scăderea ratei de teste trecute. Calcul propus: mediană pe cele trei repetări ale fiecărei sarcini, apoi mediana reducerilor relative pe cele șase perechi de sarcini; raportăm și fiecare pereche și totalurile, nu doar procentul favorabil.

Timpul și tokenii totali se raportează obligatoriu. Dacă pragul de context este atins, dar tokenii/timpul total cresc, rezultatul este «reducere de context principal», nu «economie totală de tokeni/timp». Nu atribuim un câștig general fără măsurare.

## 10. Verificări înainte de distribuire

1. Contractele inputurilor propuse trec schemele uneltelor existente; nu se transmit câmpuri inventate precum `file_path` către `jev_find`.
2. Helperul este testat pe fișiere modificate, staged, noi, redenumite, symlinkuri, Unicode, bugete și denylist; niciun fragment nu este scris în cache.
3. Schimbarea hash-ului invalidează localizarea/testele/gate-ul relevant; un gate pe snapshot vechi nu satisface finalizarea.
4. Retry operațional limitat; contradicțiile nu se pierd; rezultatele `review`, `escalate`, `invalid_response` și indisponibilitatea au ramuri distincte.
5. `claude plugin validate .` și smoke pe 2.1.283: skill, comenzi namespaced, subagent, hints, strict opt-in și protecție împotriva buclelor.
6. Smoke OpenCode 2.0.12: lista skill/agent/commands, invocare în copil, evenimente V2 reale, coliziuni și degradare; nu doar compilare cu tipuri V1.
7. Diferența față de upstream conține numai fișiere private noi și modificări ale packagingului privat.
8. Rulăm A/B înainte de a afirma că flow-ul economisește timp sau tokeni.

**Rezultatul urmărit:** agentul principal primește localizări precise și dovezi compacte, implementează folosind sursele reale și finalizează pe baza verificărilor efective. Jev ajută la selecție și evaluare; pluginul privat asigură distribuția, orchestrarea și măsurarea.
