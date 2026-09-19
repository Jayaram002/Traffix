.PHONY: seed demo test run

seed:
	python seed.py

demo:
	python main.py --mode server --port 8000

test:
	python -m unittest discover -s traffix/tests

run:
	python main.py --mode server --port 8000
