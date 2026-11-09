"""Natural-voice review: it must catch templated prose and leave varied prose alone."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from utilis.style import analyse, to_markdown

ok = 0


def chk(label, condition, detail=""):
    global ok
    print(("PASS  " if condition else "FAIL  ") + label + (f"   [{detail}]" if detail and not condition else ""))
    ok += bool(condition)


robotic = """
Moreover, the system is important for the modern home. Furthermore, the system is
robust and seamless. Additionally, the system is a testament to modern engineering.
In conclusion, the system plays a crucial role in the landscape of security.
The system is important. The system is robust. The system is seamless.
"""

natural = """
In 1987, a narrow PIR module cost more than a week's wages in Lagos. Today the same
part sells for less than a loaf of bread. That collapse changed who could build a
motion alarm: students, small workshops, and electricians working from a bench.

The sensor itself did not improve much. What changed was the microcontroller. A
cheap board could now sample two inputs, ignore a pet, and send a message. The
design problem moved from "can we detect motion" to "which motion is worth waking
someone for".
"""

robot = analyse(robotic)
human = analyse(natural)

chk("robotic prose is detected", robot["verdict"] == "robotic", robot["verdict"])
chk("robotic score is low", robot["score"] < 60, robot["score"])
chk("stock phrases are named", len(robot["stock_phrases"]) >= 3, robot["stock_phrases"])
chk("natural prose is left alone", human["verdict"] == "natural", human["verdict"])
chk("natural score is high", human["score"] >= 80, human["score"])
chk("natural prose has no stock findings", not human["stock_phrases"], human["stock_phrases"])
chk("metrics carry sentence variation", human["metrics"]["sentences"] > 0 and "sentence_length_cv" in human["metrics"])
chk("report is explicit that it is not an authorship score", "not an authorship probability" in robot["note"])
chk("markdown artifact renders", "Natural voice review" in to_markdown(robot))

print(f"\n{'ALL PASS' if ok == 9 else 'FAILURES'}: {ok}/9")
raise SystemExit(0 if ok == 9 else 1)
