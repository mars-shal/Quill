import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useStore } from "../state/store";
import type { Api, ProjectSummary } from "../lib/api";
import { pickSourceFile } from "../lib/native";
import BookCover from "./BookCover";
import WelcomeOverlay from "./WelcomeOverlay";

const SUBJECT_BY_EXT: Record<string, string> = {
    ".md": "Markdown",
    ".txt": "Plain text",
    ".docx": "Word",
    ".pdf": "PDF",
    ".pptx": "Slides",
};

function subjectFor(filePath: string | null): string {
    if (!filePath) return "Notes";
    const dot = filePath.lastIndexOf(".");
    return dot >= 0
        ? (SUBJECT_BY_EXT[filePath.slice(dot).toLowerCase()] ?? "Notes")
        : "Notes";
}

function safeBaseName(title: string, projectId: string): string {
    return title.replace(/[\\/:*?"<>|]/g, "-") || projectId;
}

/** Landing view with no open document: open a source file, start blank, or
 * pick an existing project from the library. */
export default function LibraryScreen() {
    const api = useStore((s) => s.api);
    const projects = useStore((s) => s.projects);
    const openFilePath = useStore((s) => s.openFilePath);
    const newDoc = useStore((s) => s.newDoc);
    const openProject = useStore((s) => s.openProject);
    const deleteProject = useStore((s) => s.deleteProject);
    const showToast = useStore((s) => s.showToast);
    const refreshProjects = useStore((s) => s.refreshProjects);
    const [menu, setMenu] = useState<{
        project: ProjectSummary;
        x: number;
        y: number;
    } | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const [renameTitle, setRenameTitle] = useState("");
    const [selecting, setSelecting] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [confirmBatch, setConfirmBatch] = useState(false);

    useEffect(() => {
        void refreshProjects();
    }, [refreshProjects]);

    useEffect(() => {
        if (!selecting) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape" && !confirmBatch) exitSelectMode();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [selecting, confirmBatch]);

    function exitSelectMode() {
        setSelecting(false);
        setSelected(new Set());
        setConfirmBatch(false);
    }

    function toggleSelected(id: string) {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    function selectAll() {
        setSelected(new Set(projects.map((p) => p.project_id)));
    }

    async function deleteBatch() {
        if (!confirmBatch) {
            setConfirmBatch(true);
            return;
        }
        const ids = [...selected];
        exitSelectMode();
        for (const id of ids) await deleteProject(id);
        showToast(
            ids.length === 1 ? "Document deleted" : `${ids.length} documents deleted`,
        );
    }

    useEffect(() => {
        if (!menu) return;
        const close = () => {
            setMenu(null);
            setConfirming(false);
            setRenaming(false);
        };
        window.addEventListener("click", close);
        window.addEventListener("blur", close);
        return () => {
            window.removeEventListener("click", close);
            window.removeEventListener("blur", close);
        };
    }, [menu]);

    async function renameProject() {
        if (!api || !menu) return;
        const title = renameTitle.trim();
        if (!title || title === menu.project.title) {
            setRenaming(false);
            return;
        }
        try {
            await api.renameProject(menu.project.project_id, title);
            await refreshProjects();
            showToast("Document renamed");
        } catch (error) {
            showToast(`Rename failed: ${String(error)}`);
        }
        closeMenu();
    }

    async function saveCover(project: ProjectSummary, saveAs: boolean) {
        if (!api) return;
        const fileName = `${safeBaseName(project.title, project.project_id)}.md`;
        let outPath: string | null = null;
        if (window.quill) {
            if (saveAs) {
                outPath = await window.quill.pickSaveFile(fileName, "md");
                if (!outPath) return;
            } else {
                const dir = await window.quill.documentsDir();
                if (dir) outPath = `${dir}/${fileName}`;
            }
        }
        try {
            const path = await api.export(
                project.project_id,
                "md",
                outPath ?? undefined,
            );
            showToast(`Saved → ${path}`);
        } catch (error) {
            showToast(`Save failed: ${String(error)}`);
        }
    }

    function closeMenu() {
        setMenu(null);
        setConfirming(false);
        setRenaming(false);
    }

    return (
        <div className="library">
            <WelcomeOverlay />
            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease: "easeOut" }}
            >
                <h1>Quill</h1>
                <p>
                    An IDE for writers. Ingest a document, generate with AI, refine by
                    hand.
                </p>
            </motion.div>
            <motion.div
                className="welcome-actions"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.28, ease: "easeOut", delay: 0.06 }}
            >
                <button
                    className="primary"
                    disabled={!api}
                    onClick={async () => {
                        const filePath = await pickSourceFile();
                        if (filePath) await openFilePath(filePath);
                    }}
                >
                    Open a source document…
                </button>
                <button disabled={!api} onClick={() => void newDoc()}>
                    Start a blank document
                </button>
            </motion.div>
            <div className="library-section ">
                <div className="library-head">
                    <h2>Your documents</h2>
                    {selecting ? (
                        <div className="library-select-bar">
                            <span className="library-select-count">
                                {selected.size} selected
                            </span>
                            <button
                                onClick={selectAll}
                                disabled={
                                    projects.length === 0 || selected.size === projects.length
                                }
                            >
                                Select all
                            </button>
                            <button
                                className={confirmBatch ? "confirm" : "danger"}
                                disabled={selected.size === 0}
                                onClick={() => void deleteBatch()}
                            >
                                {confirmBatch ? `Confirm delete ${selected.size}?` : "Delete…"}
                            </button>
                            <button onClick={exitSelectMode}>Done</button>
                        </div>
                    ) : (
                        <button
                            className="select-toggle"
                            onClick={() => setSelecting(true)}
                            disabled={projects.length === 0}
                        >
                            Select
                        </button>
                    )}
                </div>
                {projects.length === 0 ? (
                    <p className="hint">
                        No documents yet. Open a source file or start blank.
                    </p>
                ) : (
                    <motion.ul
                        className="library-covers"
                        initial="hidden"
                        animate="show"
                        variants={{
                            hidden: {},
                            show: { transition: { staggerChildren: 0.03 } },
                        }}
                    >
                        <AnimatePresence>
                            {projects.map((p) => (
                                <motion.li
                                    key={p.project_id}
                                    layout
                                    variants={{
                                        hidden: { opacity: 0, y: 12 },
                                        show: {
                                            opacity: 1,
                                            y: 0,
                                            transition: { duration: 0.25, ease: "easeOut" },
                                        },
                                        exit: {
                                            opacity: 0,
                                            scale: 0.85,
                                            y: 8,
                                            transition: { duration: 0.18, ease: "easeIn" },
                                        },
                                    }}
                                >
                                <button
                                    className={`cover-item${selected.has(p.project_id) ? " selected" : ""}`}
                                    onClick={() => {
                                        if (selecting) toggleSelected(p.project_id);
                                        else void openProject(p.project_id);
                                    }}
                                    onContextMenu={(e) => {
                                        if (selecting) return;
                                        e.preventDefault();
                                        setMenu({ project: p, x: e.clientX, y: e.clientY });
                                        setConfirming(false);
                                    }}
                                >
                                    <span className="cover-frame">
                                        <BookCover
                                            seed={p.project_id}
                                            title={p.title}
                                            subject={subjectFor(p.file_path)}
                                            meta={`${p.section_count ?? 0} sections · ${(p.total_words ?? 0).toLocaleString()} words`}
                                        />
                                        {selecting && (
                                            <span
                                                className={`cover-check${selected.has(p.project_id) ? " on" : ""}`}
                                            >
                                                ✓
                                            </span>
                                        )}
                                    </span>
                                    <span className="cover-item-title">{p.title}</span>
                                </button>
                            </motion.li>
                        ))}
                        </AnimatePresence>
                    </motion.ul>
                )}
            </div>
            {menu && (
                <div
                    className="context-menu"
                    style={{
                        left: Math.min(menu.x, window.innerWidth - 180),
                        top: Math.min(menu.y, window.innerHeight - 132),
                    }}
                    onClick={(e) => e.stopPropagation()}
                >
                    {renaming ? (
                        <form
                            className="context-menu-rename"
                            onSubmit={(e) => {
                                e.preventDefault();
                                void renameProject();
                            }}
                        >
                            <input
                                autoFocus
                                value={renameTitle}
                                onChange={(e) => setRenameTitle(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Escape") setRenaming(false);
                                }}
                                placeholder="Document title"
                            />
                            <div className="context-menu-actions">
                                <button type="button" onClick={() => setRenaming(false)}>
                                    Cancel
                                </button>
                                <button
                                    className="primary"
                                    type="submit"
                                    disabled={!renameTitle.trim()}
                                >
                                    Rename
                                </button>
                            </div>
                        </form>
                    ) : (
                        <>
                            <button
                                onClick={() => {
                                    const pid = menu.project.project_id;
                                    closeMenu();
                                    void openProject(pid);
                                }}
                            >
                                Edit
                            </button>
                            <button
                                onClick={() => {
                                    setRenameTitle(menu.project.title);
                                    setRenaming(true);
                                }}
                            >
                                Rename…
                            </button>
                            <button
                                onClick={() => {
                                    const project = menu.project;
                                    closeMenu();
                                    void saveCover(project, false);
                                }}
                            >
                                Save
                            </button>
                            <button
                                onClick={() => {
                                    const project = menu.project;
                                    closeMenu();
                                    void saveCover(project, true);
                                }}
                            >
                                Save as Markdown…
                            </button>
                            <div className="context-menu-sep" />
                            <button
                                className={confirming ? "confirm" : "danger"}
                                onClick={async () => {
                                    if (!confirming) {
                                        setConfirming(true);
                                        return;
                                    }
                                    const pid = menu.project.project_id;
                                    closeMenu();
                                    await deleteProject(pid);
                                }}
                            >
                                {confirming ? "Confirm delete?" : "Delete document"}
                            </button>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
