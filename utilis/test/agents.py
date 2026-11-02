import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from model import Agent

agent = Agent()
# response = agent.model(model_name="allam-2-7b", prompt="yooo in english", system_prompt="You are a helpful assistant help me to write my report and documents")
response = agent.Nous(prompt="CAn u research more about MAin use http://Widijd.com")
print(response)