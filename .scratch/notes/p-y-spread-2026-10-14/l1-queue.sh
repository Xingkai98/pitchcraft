#!/bin/bash
N=/tmp/y-axis/.scratch/notes/p-y-spread-2026-10-14
bash $N/l1-parallel.sh "P 1.1 p110" "P 0.85 p085"
bash $N/l1-parallel.sh "P 0.9 p090" "P 0.6 p060"
bash $N/l1-parallel.sh "Q 0.77 q077"
echo L1-ALL-DONE >> $N/logs/sweep.log
