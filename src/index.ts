import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  INotebookTracker,
  NotebookActions,
  Notebook
} from '@jupyterlab/notebook';
import { CodeCell, Cell, isCodeCellModel } from '@jupyterlab/cells';

const CHAPYTER_CHAT_CELL = 'jp-chapyter-chat';
const CHAPYTER_CHAT_CELL_EXECUTING = 'jp-chapyter-chat-executing';
const CHAPYTER_ASSISTANCE_CELL = 'jp-chapyter-assistance';

type ChapyterCellMetadata = {
  linkedCellId?: string;
  cellType: 'generated' | 'original';
};

/**
 * Check if the cell is not generated by Chapyter
 */
function isCellNotGenerated(cell: Cell): boolean {
  if (isCodeCellModel(cell.model)) {
    let metadata =
      (cell.model.getMetadata('ChapyterCell') as ChapyterCellMetadata) || null;
    if (metadata && metadata.cellType === 'generated') {
      return false;
    }
  }
  return true;
}

/**
 * Iterate through the notebook and find the cell with the given ID
 */
function findCellById(notebook: Notebook, id: string): Cell | null {
  for (let i = 0; i < notebook.widgets.length; i++) {
    let cell = notebook.widgets[i];
    if (cell.model.id === id) {
      return cell;
    }
  }
  return null;
}

/**
 * Iterate through the notebook and find the code cell that starts with the
 * given template string. In our case, the template string is simply a manual
 * template that's inserted by Chapyter.
 */
function findCellByTemplateString(
  notebook: Notebook,
  executionId: string | number | null
): CodeCell | null {
  if (executionId) {
    const searchTempalte = `# Assistant Code for Cell [${executionId}]:`;

    for (let i = 0; i < notebook.widgets.length; i++) {
      let cell = notebook.widgets[i];
      if (cell.model.type === 'code') {
        let codeCell = cell as CodeCell;
        let codeCellText = codeCell.model.sharedModel.getSource();
        if (codeCellText.split('\n')[0].startsWith(searchTempalte)) {
          return cell as CodeCell;
        }
      }
    }
  }
  return null;
}

/**
 * Find the index of the cell with the given ID
 */
function findCellIndexById(notebook: Notebook, id: string): number {
  for (let i = 0; i < notebook.widgets.length; i++) {
    let cell = notebook.widgets[i];
    if (cell.model.id === id) {
      return i;
    }
  }
  return -1;
}

/**
 * Select the target cell based on its id by moving the cursor
 * (using NotebookActions.selectAbove or NotebookActions.selectAbove).
 */
function selectCellById(notebook: Notebook, id: string): void {
  let activeCellIndex = notebook.activeCellIndex;
  let targetCellIndex = findCellIndexById(notebook, id);
  if (targetCellIndex !== -1) {
    if (activeCellIndex !== targetCellIndex) {
      if (activeCellIndex < targetCellIndex) {
        for (let i = activeCellIndex; i < targetCellIndex; i++) {
          if (!notebook.widgets[i].inputHidden) {
            NotebookActions.selectBelow(notebook);
          }
        }
      } else {
        for (let i = activeCellIndex; i > targetCellIndex; i--) {
          if (!notebook.widgets[i].inputHidden) {
            NotebookActions.selectAbove(notebook);
          }
        }
      }
    }
  }
}

/**
 * Check if the code cell is a Chapyter magic cell
 * i.e., the cell starts with %chat or %%chat
 */
function isCellChapyterMagicCell(
  cell: CodeCell,
  strict: boolean = false
): boolean {
  let codeCellText = cell.model.sharedModel.getSource();
  if (codeCellText.startsWith('%chat') || codeCellText.startsWith('%%chat')) {
    if (!codeCellText.startsWith('%%chatonly') || !strict) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a cell is a Chapyter magic cell in safe mode
 * indicated by the -s or --safe flag
 */
function isCellChapyterMagicCellSafeMode(cell: CodeCell): boolean {
  let codeCellText = cell.model.sharedModel.getSource();
  let firstLine = codeCellText.split('\n')[0];
  return firstLine.includes('-s') || firstLine.includes('--safe');
}

/**
 * Delete the cell from the notebook
 */
function deleteCell(notebook: Notebook, cell: Cell): void {
  const model = notebook.model!;
  const sharedModel = model.sharedModel;
  const toDelete: number[] = [];

  notebook.widgets.forEach((child, index) => {
    if (child === cell) {
      const deletable = child.model.getMetadata('deletable') !== false;

      if (deletable) {
        toDelete.push(index);
        notebook.model?.deletedCells.push(child.model.id);
      }
    }
  });

  if (toDelete.length > 0) {
    // Delete the cells as one undo event.
    sharedModel.transact(() => {
      // Delete cells in reverse order to maintain the correct indices.
      toDelete.reverse().forEach(index => {
        sharedModel.deleteCell(index);
      });
    });
    // Select the *first* interior cell not deleted or the cell
    // *after* the last selected cell.
    // Note: The activeCellIndex is clamped to the available cells,
    // so if the last cell is deleted the previous cell will be activated.
    // The *first* index is the index of the last cell in the initial
    // toDelete list due to the `reverse` operation above.
    notebook.activeCellIndex = toDelete[0] - toDelete.length + 1;
  }

  // Deselect any remaining, undeletable cells. Do this even if we don't
  // delete anything so that users are aware *something* happened.
  notebook.deselectAll();
}

/**
 * Initialization data for the @shannon-shen/chapyter extension.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: '@shannon-shen/chapyter:plugin',
  description: 'A Natural Language-Based Python Program Interpreter',
  autoStart: true,
  requires: [INotebookTracker],
  // optional: [ISettingRegistry],
  activate: (app: JupyterFrontEnd, tracker: INotebookTracker) => {
    NotebookActions.executed.connect((sender, args) => {
      if (args.success) {
        // It must be true that the cell is a code cell (otherwise it would not have been executed)
        let chatCell = args.cell as CodeCell;

        // We only want to automatically generate a new cell if the code cell starts with a magic command (e.g. %chat)
        if (
          isCellChapyterMagicCell(chatCell, true) &&
          isCellNotGenerated(chatCell)
        ) {
          // this is the original code cell that was executed
          if (chatCell.model.getMetadata('ChapyterCell') === undefined) {
            chatCell.model.setMetadata('ChapyterCell', {
              cellType: 'original'
            });
          }
          let inSafeMode = isCellChapyterMagicCellSafeMode(chatCell);

          // because it is successfully executed
          let notebook = tracker.currentWidget;
          if (notebook) {
            let assistanceCell = findCellByTemplateString(
              notebook.content,
              chatCell.model.executionCount
            );

            if (assistanceCell) {
              assistanceCell.model.setMetadata('ChapyterCell', {
                cellType: 'generated',
                linkedCellId: chatCell.model.id // the original cell ID
              });
              
              console.log(inSafeMode)
              if (!inSafeMode) {
                selectCellById(notebook.content, assistanceCell.model.id);
                NotebookActions.run(notebook.content, notebook.sessionContext);
                assistanceCell.inputHidden = true;
              }

              // The removal of existing linked cells is handled in the executionScheduled event

              /**
               * We want to run the next check for avoiding duplicate cells.
               * Imagine when we are redistributing the notebook: we have already run the
               * chapter cell with the magic command, and the jupyter notebook generates
               * a new cell below the executed cell. Then another person opens the notebook
               * and executes the same chapyter cell. We want to delete the original generated
               * cell and only keep the newly generated cell.
               *
               * The logic is important: if it's on the same machine, then the caching mechanism
               * in guidance will produce us the same code and the user won't feel any difference.
               * However if it's on a different machine, then the generated code will become
               * different and the user will see a different result.
               *
               * We also need to execute this check after the previous cell is executed. Consider
               * the corner case when the (previous) generated cell is the last cell inside a juptyer
               * notebook. If we execute the check before the previous cell is executed, then jupyter
               * will move up (instead of moving down) the active cell and it will confuse the logic
               * for executing the next cell.
               */

              selectCellById(notebook.content, assistanceCell.model.id);
              if (!inSafeMode) {
                NotebookActions.selectBelow(notebook.content);
              }

              // set the proper linked cell ID
              chatCell.model.setMetadata('ChapyterCell', {
                cellType: 'original',
                linkedCellId: assistanceCell.model.id
              });

              chatCell.addClass(CHAPYTER_CHAT_CELL);
              chatCell.removeClass(CHAPYTER_CHAT_CELL_EXECUTING);
              assistanceCell.addClass(CHAPYTER_ASSISTANCE_CELL);
            }
          }
        }
      }
    });

    NotebookActions.executionScheduled.connect((sender, args) => {
      // It must be true that the cell is a code cell (otherwise it would not have been executed)
      let chatCell = args.cell as CodeCell;

      // We want to automatically remove existing generated cells if we are running the chapyter cell
      if (isCellChapyterMagicCell(chatCell) && isCellNotGenerated(chatCell)) {
        chatCell.toggleClass(CHAPYTER_CHAT_CELL_EXECUTING);
        let linkedCellId =
          chatCell.model.getMetadata('ChapyterCell')?.linkedCellId;

        let notebook = tracker.currentWidget;
        if (notebook) {
          if (linkedCellId) {
            let linkedCell = findCellById(notebook.content, linkedCellId);
            if (linkedCell) {
              deleteCell(notebook.content, linkedCell);

              /**
               * Make sure we select the right cell after the deletion:
               * Because we will use the selectBelow function when executing the generated
               * code cell, we want to make sure we are selecting the current codeCell in this
               * executionScheduled event.
               */
              selectCellById(notebook.content, chatCell.model.id);
            }
          }
        }
      }
    });
  }
};

export default plugin;
