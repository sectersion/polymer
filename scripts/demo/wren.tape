# scripts/demo/wren.tape — the terminal act: wren's agent loop
# Deterministic retake = rerun this file. ASCII-safe: uses the mono font
# installed by setup-demo-deps.sh.
Output docs/demo/wren-terminal.gif
Set FontSize 22
Set Width 1600
Set Height 500
Set Padding 40
Set Theme { "name": "dark", "background": "#161b22", "foreground": "#e6edf3", "black": "#484f58", "red": "#ff7b72", "green": "#3fb950", "yellow": "#d29922", "blue": "#58a6ff", "magenta": "#bc8cff", "cyan": "#39c5cf", "white": "#b1bac4" }

Type "echo '· mason was called away — 75s lease on the clock…'"
Enter
Sleep 2s
Ctrl+L
Type "node scripts/demo/wren.mjs"
Enter
Sleep 50s
