/**
 * CKEditor dataview nodes can be converted to a output view or an editor view via downcasting
 *  * Upcasting is converting to the platonic ckeditor version.
 *  * Downcasting is converting to the output version.
 */

import { addFootnoteAutoformatting } from './auto-formatting.js';
import { defineConverters } from './converters.js';
import { defineSchema } from './schema.js';

import { ATTRIBUTES, COMMANDS, ELEMENTS } from '../constants.js';
import InsertFootnoteCommand from '../insert-footnote-command.js';
import { modelQueryElement, modelQueryElementsAll } from '../utils.js';
import { Autoformat, Batch, ModelElement, Plugin, ModelRootElement, viewToModelPositionOutsideModelElement, Widget, ModelWriter } from 'ckeditor5';

export default class FootnoteEditing extends Plugin {

	public static get pluginName() {
		return 'FootnotesEditing' as const;
	}

	public static get requires() {
		return [ Widget, Autoformat ] as const;
	}

	/**
   * The root element of the document.
   */
	public get rootElement(): ModelRootElement {
		const rootElement = this.editor.model.document.getRoot();
		if ( !rootElement ) {
			throw new Error( 'Document has no rootElement element.' );
		}
		return rootElement;
	}

	public init(): void {
		defineSchema( this.editor.model.schema );
		defineConverters( this.editor );

		this.editor.commands.add( COMMANDS.insertFootnote, new InsertFootnoteCommand( this.editor ) );

		addFootnoteAutoformatting( this.editor, this.rootElement );

		this.editor.model.document.on(
			'change:data',
			( eventInfo, batch ) => {
				const eventSource: any = eventInfo.source;
				const diffItems = [ ...eventSource.differ.getChanges() ];
				// If a footnote reference is inserted, ensure that footnote references remain ordered.
				if ( diffItems.some( diffItem => diffItem.type === 'insert' && diffItem.name === ELEMENTS.footnoteReference ) ) {
					this._orderFootnotes( batch );
				}
				// for each change to a footnote item's index attribute, update the corresponding references accordingly
				diffItems.forEach( diffItem => {
					if ( diffItem.type === 'attribute' && diffItem.attributeKey === ATTRIBUTES.footnoteIndex ) {
						const { attributeNewValue: newFootnoteIndex } = diffItem;
						const footnote = [ ...diffItem.range.getItems() ].find( item => item.is( 'element', ELEMENTS.footnoteItem ) );
						const footnoteId = footnote instanceof ModelElement && footnote.getAttribute( ATTRIBUTES.footnoteId );
						if ( !footnoteId ) {
							return;
						}
						this._updateReferenceIndices( batch, `${ footnoteId }`, newFootnoteIndex );
					}
				} );
			},
			{ priority: 'high' }
		);

		this._handleDelete();

		// The following callbacks are needed to map nonempty view elements
		// to empty model elements.
		// See https://ckeditor.com/docs/ckeditor5/latest/api/module_widget_utils.html#function-viewToModelPositionOutsideModelElement
		this.editor.editing.mapper.on(
			'viewToModelPosition',
			viewToModelPositionOutsideModelElement( this.editor.model, viewElement =>
				viewElement.hasAttribute( ATTRIBUTES.footnoteReference )
			)
		);
	}

	/**
   * This method broadly deals with deletion of text and elements, and updating the model
   * accordingly. In particular, the following cases are handled:
   * 1. If the footnote section gets deleted, all footnote references are removed.
   * 2. If a delete operation happens in an empty footnote, the footnote is deleted.
   */
	private _handleDelete() {
		const viewDocument = this.editor.editing.view.document;
		const editor = this.editor;
		this.listenTo(
			viewDocument,
			'delete',
			( evt, data ) => {
				const doc = editor.model.document;
				const deletedElement = doc.selection.getSelectedElement();
				const selectionEndPos = doc.selection.getLastPosition();
				const selectionStartPos = doc.selection.getFirstPosition();
				if ( !selectionEndPos || !selectionStartPos ) {
					throw new Error( 'Selection must have at least one range to perform delete operation.' );
				}

				this.editor.model.change( modelWriter => {
					// delete all footnote references if footnote section gets deleted
					if ( deletedElement && deletedElement.is( 'element', ELEMENTS.footnoteSection ) ) {
						this._removeReferences( modelWriter );
					}

					const deletingFootnote = deletedElement && deletedElement.is( 'element', ELEMENTS.footnoteItem );

					const currentFootnote = deletingFootnote ?
						deletedElement :
						selectionEndPos.findAncestor( ELEMENTS.footnoteItem );
					if ( !currentFootnote ) {
						return;
					}

					const endParagraph = selectionEndPos.findAncestor( 'paragraph' );
					const startParagraph = selectionStartPos.findAncestor( 'paragraph' );
					const currentFootnoteContent = selectionEndPos.findAncestor( ELEMENTS.footnoteContent );
					if ( !currentFootnoteContent || !startParagraph || !endParagraph ) {
						return;
					}

					const footnoteIsEmpty = startParagraph.maxOffset === 0 && currentFootnoteContent.childCount === 1;

					if ( deletingFootnote || footnoteIsEmpty ) {
						this._removeFootnote( modelWriter, currentFootnote );
						data.preventDefault();
						evt.stop();
					}
				} );
			},
			{ priority: 'high' }
		);
	}

	/**
   * Clear the children of the provided footnoteContent element,
   * leaving an empty paragraph behind. This allows users to empty
   * a footnote without deleting it. modelWriter is passed in to
   * batch these changes with the ones that instantiated them,
   * such that the set can be undone with a single action.
   */
	private _clearContents( modelWriter: ModelWriter, footnoteContent: ModelElement ) {
		const contents = modelWriter.createRangeIn( footnoteContent );
		modelWriter.appendElement( 'paragraph', footnoteContent );
		modelWriter.remove( contents );
	}

	/**
   * Removes a footnote and its references, and renumbers subsequent footnotes. When a footnote's
   * id attribute changes, it's references automatically update from a dispatcher event in converters.js,
   * which triggers the `updateReferenceIds` method. modelWriter is passed in to batch these changes with
   * the ones that instantiated them, such that the set can be undone with a single action.
   */
	private _removeFootnote( modelWriter: ModelWriter, footnote: ModelElement ) {
		// delete the current footnote and its references,
		// and renumber subsequent footnotes.
		if ( !this.editor ) {
			return;
		}
		const footnoteSection = footnote.findAncestor( ELEMENTS.footnoteSection );

		if ( !footnoteSection ) {
			modelWriter.remove( footnote );
			return;
		}
		const index = footnoteSection.getChildIndex( footnote );
		const id = footnote.getAttribute( ATTRIBUTES.footnoteId );
		this._removeReferences( modelWriter, `${ id }` );

		modelWriter.remove( footnote );
		// if no footnotes remain, remove the footnote section
		if ( footnoteSection.childCount === 0 ) {
			modelWriter.remove( footnoteSection );
			this._removeReferences( modelWriter );
		} else {
			if ( index == null ) {
				throw new Error( 'Index is nullish' );
			}
			// after footnote deletion the selection winds up surrounding the previous footnote
			// (or the following footnote if no previous footnote exists). Typing in that state
			// immediately deletes the footnote. This deliberately sets the new selection position
			// to avoid that.
			const neighborFootnote = index === 0 ? footnoteSection.getChild( index ) : footnoteSection.getChild( ( index ?? 0 ) - 1 );
			if ( !( neighborFootnote instanceof ModelElement ) ) {
				return;
			}

			const neighborEndParagraph = modelQueryElementsAll( this.editor, neighborFootnote, element =>
				element.is( 'element', 'paragraph' )
			).pop();

			if ( neighborEndParagraph ) {
				modelWriter.setSelection( neighborEndParagraph, 'end' );
			}
		}
		if ( index == null ) {
			throw new Error( 'Index is nullish' );
		}
		// renumber subsequent footnotes
		const subsequentFootnotes = [ ...footnoteSection.getChildren() ].slice( index ?? 0 );
		for ( const [ i, child ] of subsequentFootnotes.entries() ) {
			modelWriter.setAttribute( ATTRIBUTES.footnoteIndex, `${ index ?? 0 + i + 1 }`, child );
		}
	}

	/**
   * Deletes all references to the footnote with the given id. If no id is provided,
   * all references are deleted. modelWriter is passed in to batch these changes with
   * the ones that instantiated them, such that the set can be undone with a single action.
   */
	private _removeReferences( modelWriter: ModelWriter, footnoteId: string | undefined = undefined ) {
		const removeList: Array<any> = [];
		if ( !this.rootElement ) {
			throw new Error( 'Document has no root element.' );
		}
		const footnoteReferences = modelQueryElementsAll( this.editor, this.rootElement, e =>
			e.is( 'element', ELEMENTS.footnoteReference )
		);
		footnoteReferences.forEach( footnoteReference => {
			const id = footnoteReference.getAttribute( ATTRIBUTES.footnoteId );
			if ( !footnoteId || id === footnoteId ) {
				removeList.push( footnoteReference );
			}
		} );
		for ( const item of removeList ) {
			modelWriter.remove( item );
		}
	}

	/**
   * Updates all references for a single footnote. This function is called when
   * the index attribute of an existing footnote changes, which happens when a footnote
   * with a lower index is deleted. batch is passed in to group these changes with
   * the ones that instantiated them.
   */
	private _updateReferenceIndices( batch: Batch, footnoteId: string, newFootnoteIndex: string ) {
		const footnoteReferences = modelQueryElementsAll(
			this.editor,
			this.rootElement,
			e => e.is( 'element', ELEMENTS.footnoteReference ) && e.getAttribute( ATTRIBUTES.footnoteId ) === footnoteId
		);
		this.editor.model.enqueueChange( batch, writer => {
			footnoteReferences.forEach( footnoteReference => {
				writer.setAttribute( ATTRIBUTES.footnoteIndex, newFootnoteIndex, footnoteReference );
			} );
		} );
	}

	/**
   * Reindexes footnotes such that footnote references occur in order, and reorders
   * footnote items in the footer section accordingly. batch is passed in to group changes with
   * the ones that instantiated them.
   */
	private _orderFootnotes( batch: Batch ) {
		const footnoteReferences = modelQueryElementsAll( this.editor, this.rootElement, e =>
			e.is( 'element', ELEMENTS.footnoteReference )
		);
		const uniqueIds = new Set( footnoteReferences.map( e => e.getAttribute( ATTRIBUTES.footnoteId ) ) );
		const orderedFootnotes = [ ...uniqueIds ].map( id =>
			modelQueryElement(
				this.editor,
				this.rootElement,
				e => e.is( 'element', ELEMENTS.footnoteItem ) && e.getAttribute( ATTRIBUTES.footnoteId ) === id
			)
		);

		this.editor.model.enqueueChange( batch, writer => {
			const footnoteSection = modelQueryElement( this.editor, this.rootElement, e =>
				e.is( 'element', ELEMENTS.footnoteSection )
			);
			if ( !footnoteSection ) {
				return;
			}

			/**
       * In order to keep footnotes with no existing references at the end of the list,
       * the loop below reverses the list of footnotes with references and inserts them
       * each at the beginning.
       */
			for ( const footnote of orderedFootnotes.reverse() ) {
				if ( footnote ) {
					writer.move( writer.createRangeOn( footnote ), footnoteSection, 0 );
				}
			}

			/**
       * once the list is sorted, make one final pass to update footnote indices.
       */
			for ( const footnote of modelQueryElementsAll( this.editor, footnoteSection, e =>
				e.is( 'element', ELEMENTS.footnoteItem )
			) ) {
				const index = `${ ( footnoteSection?.getChildIndex( footnote ) ?? -1 ) + 1 }`;
				if ( footnote ) {
					writer.setAttribute( ATTRIBUTES.footnoteIndex, index, footnote );
				}
				const id = footnote.getAttribute( ATTRIBUTES.footnoteId );

				// 		/**
				//  * unfortunately the following line seems to be necessary, even though updateReferenceIndices
				//  * should fire from the attribute change immediately above. It seems that events initiated by
				//  * a `change:data` event do not themselves fire another `change:data` event.
				//  */
				if ( id ) {
					this._updateReferenceIndices( batch, `${ id }`, `${ index }` );
				}
			}
		} );
	}
}
