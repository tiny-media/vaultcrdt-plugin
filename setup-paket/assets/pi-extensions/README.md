# Pi-Extensions Assets

Diese Dateien sind wiederverwendbare Pi-Extension-Bausteine des `coding-agent-setup`.

## `anchor-return.ts`

Status: v0.3-Spike.

Zweck:

```text
/anchor <name> -> temporär explorieren -> /distill <name> --to <file> -> /return <name> --with <file>
```

Im aktuellen Repo ist die Extension projektlokal über `.pi/extensions/anchor-return/index.ts` eingebunden.

Kommandos:

- `/anchor <name> [note]`
- `/anchors`
- `/distill <name> [--to file.md] [--send]`
- `/return <name> [--with file.md] [--summarize]`

Guide:

- `setup-paket/guides/pi-anker-return-workflow.md`

Bewusst noch minimal:

- `/distill` erstellt einen Verdichtungsauftrag, prüft aber nicht automatisch die geschriebene Datei
- kein vollautomatisches Distill-and-Return ohne Richard-Prüfung
- keine automatische Rückmeldung an andere Sessions
- kein automatischer Memory-Sync
- erst Alltagstest, dann Ausbau
