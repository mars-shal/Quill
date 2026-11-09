"""Compatibility shim for the evaluation harness.

The implementation lives in `utilis/verification.py` so the app can use the
same citation, plagiarism and OSINT checks the report uses.
"""

from utilis.verification import analyse_document, verify_citation, main  # noqa: F401

if __name__ == "__main__":
    main()
