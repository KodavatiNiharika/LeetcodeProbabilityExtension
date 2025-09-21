## Overview
This extension allows users to know their possibility of solving a problem based on their past submissions.

## Features
Factors involved for possibility calculation:

1. **Users acceptance rate for a tag** - hash table, arrays, strings, etc  
   One can't say that there is 100% chance of solving a problem, if user had previously done 1 problem correctly under the same tag  
   This case is handled by:  
   1. Considering problems solved and attempted by user - familiarity  
   2. Considering problems solved and total problems under a tag - accuracy

2. **Difficulty based acceptance rate** - easy, medium , hard  
   1. Total problems under a difficulty level vs problems solved by user under that level

3. **User submissions statistics**  
   1. Total solved count  
   2. Total attempted count  
   3. Total wrong submissions count

4. **Multiple tag handling with GenAI**  
   Example: For a graph cycle detection problem, the tags include dfs, bfs, graph, topological sort  
   But one can solve the question with either dfs or bfs, so taking average acceptance of all the tags is not a good idea  
   So by integrating GenAI to fetch combos from the tags list - can solve using dfs or bfs  
   Now considering max acceptance rate of all combos, showing a possibility of 70 if one has 70% in dfs and 60% in bfs

## Calculation Weightage
In the final possibility calculation users acceptance rate based on tag was given 60% priority and acceptance rate based on difficulty is given 40% priority

## How to run
Steps:  
1. Clone the project  
2. Get your own gemini API key  
3. Load the extension in chrome developer mode
