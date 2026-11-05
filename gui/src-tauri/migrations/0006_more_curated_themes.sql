-- More curated themes.
--
-- Six more presets: three light sides and three dark sides. They are ordinary
-- `custom_themes` rows, exactly like the first set in 0004, so the picker treats
-- them the same way and "Save as" still produces an editable copy.
--
-- Catppuccin is the request that drove this set; the other four are the
-- palettes a writing app's theme shelf usually carries. The light palettes keep
-- the contrast their source colours could not always meet: Latte's `--text-3`
-- and accent were darkened one step, Dawn's accent and danger likewise, and
-- Everforest's publish label flipped to its light ink. Values were run through
-- `checkTokens` before being written, the same check the picker enforces.
--
-- mode decides which base the row inherits from and which ink the canvas
-- effects use, so each row names its side explicitly.

INSERT INTO custom_themes (theme_id, name, tokens_json, mode) VALUES
    ('catppuccin-latte', 'Catppuccin Latte', '{"--main":"#eff1f5","--backdrop":"#dce0e8","--sidebar":"#eef0f4","--chat":"#eef0f4","--border":"rgba(76, 79, 105, 0.16)","--border-strong":"rgba(76, 79, 105, 0.32)","--text-1":"#4c4f69","--text-2":"#5c5f77","--text-3":"#5c5f77","--prose":"#4c4f69","--accent":"#7a2fd1","--on-accent":"#ffffff","--publish":"#40a02b","--on-publish":"#1e1e2e","--danger":"#b30d31","--highlight-bg":"#ccd0da","--highlight-ink":"#4c4f69","--focus-ring":"rgba(122, 47, 209, 0.9)"}', 'light'),
    ('catppuccin-mocha', 'Catppuccin Mocha', '{"--main":"#1e1e2e","--backdrop":"#11111b","--sidebar":"#181825","--chat":"#1e1e2e","--border":"rgba(205, 214, 244, 0.14)","--border-strong":"rgba(205, 214, 244, 0.3)","--text-1":"#cdd6f4","--text-2":"#bac2de","--text-3":"#a6adc8","--prose":"#cdd6f4","--accent":"#cba6f7","--on-accent":"#1e1e2e","--publish":"#a6e3a1","--on-publish":"#11111b","--danger":"#f38ba8","--highlight-bg":"#45475a","--highlight-ink":"#cdd6f4","--focus-ring":"rgba(203, 166, 247, 0.9)"}', 'dark'),
    ('tokyo-night', 'Tokyo Night', '{"--main":"#1a1b26","--backdrop":"#16161e","--sidebar":"#1f2335","--chat":"#1f2335","--border":"rgba(192, 202, 245, 0.14)","--border-strong":"rgba(192, 202, 245, 0.3)","--text-1":"#c0caf5","--text-2":"#a9b1d6","--text-3":"#8b93b8","--prose":"#c0caf5","--accent":"#7aa2f7","--on-accent":"#1a1b26","--publish":"#9ece6a","--on-publish":"#16161e","--danger":"#f7768e","--highlight-bg":"#33467c","--highlight-ink":"#c0caf5","--focus-ring":"rgba(122, 162, 247, 0.9)"}', 'dark'),
    ('gruvbox-dark', 'Gruvbox Dark', '{"--main":"#282828","--backdrop":"#1d2021","--sidebar":"#32302f","--chat":"#3c3836","--border":"rgba(235, 219, 178, 0.14)","--border-strong":"rgba(235, 219, 178, 0.3)","--text-1":"#ebdbb2","--text-2":"#d5c4a1","--text-3":"#bdae93","--prose":"#ebdbb2","--accent":"#fabd2f","--on-accent":"#282828","--publish":"#b8bb26","--on-publish":"#1d2021","--danger":"#ff7b6b","--highlight-bg":"#504945","--highlight-ink":"#fbf1c7","--focus-ring":"rgba(250, 189, 47, 0.9)"}', 'dark'),
    ('rose-pine-dawn', 'Rose Pine Dawn', '{"--main":"#faf4ed","--backdrop":"#f2e9e1","--sidebar":"#fffaf3","--chat":"#fffaf3","--border":"rgba(87, 82, 121, 0.14)","--border-strong":"rgba(87, 82, 121, 0.3)","--text-1":"#575279","--text-2":"#625d7b","--text-3":"#625d7b","--prose":"#575279","--accent":"#6f5a8a","--on-accent":"#fffaf3","--publish":"#286983","--on-publish":"#faf4ed","--danger":"#94405a","--highlight-bg":"#f4ede8","--highlight-ink":"#575279","--focus-ring":"rgba(111, 90, 138, 0.9)"}', 'light'),
    ('everforest-light', 'Everforest Light', '{"--main":"#fdf6e3","--backdrop":"#f4f0d9","--sidebar":"#efebd4","--chat":"#fdf6e3","--border":"rgba(92, 106, 114, 0.16)","--border-strong":"rgba(92, 106, 114, 0.32)","--text-1":"#5c6a72","--text-2":"#5c6a72","--text-3":"#5f6d5c","--prose":"#5c6a72","--accent":"#5f6d00","--on-accent":"#fdf6e3","--publish":"#2f7a5a","--on-publish":"#fdf6e3","--danger":"#b8322f","--highlight-bg":"#e6e2cc","--highlight-ink":"#4f5b62","--focus-ring":"rgba(95, 109, 0, 0.9)"}', 'light');
